-- No backfill, engine reassignment, credentials or role logins are created here.
-- Source authority and its journal must share this database so revocation rows
-- remain locked until the capture COMMIT. Physical Evolution auth storage stays separate.
CREATE TABLE history_origin_engine_roles (
 role_name name PRIMARY KEY, engine_id text NOT NULL CHECK(engine_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
 generation bigint NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
 engine_fingerprint text NOT NULL CHECK(engine_fingerprint ~ '^[a-f0-9]{64}$'), enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE history_sync_connection_policies (
 organization_id uuid NOT NULL,channel_id uuid NOT NULL,instance_id uuid NOT NULL,created_by uuid,created_api_key_id uuid,
 activation_id uuid NOT NULL,engine_id text NOT NULL,engine_generation bigint NOT NULL,engine_fingerprint text NOT NULL,
 binding_fingerprint text NOT NULL,enabled boolean NOT NULL DEFAULT true,
 groups_mode text NOT NULL DEFAULT 'ALL_AUTHORIZED' CHECK(groups_mode IN ('ALL_AUTHORIZED','SELECTED')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,channel_id),UNIQUE(organization_id,channel_id,activation_id),
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id),
 FOREIGN KEY(organization_id,instance_id) REFERENCES instances(organization_id,id),FOREIGN KEY(created_by) REFERENCES users(id),
 FOREIGN KEY(organization_id,created_api_key_id) REFERENCES api_keys(organization_id,id),CHECK((created_by IS NULL)<>(created_api_key_id IS NULL))
);
CREATE TABLE history_source_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,channel_id uuid NOT NULL,instance_id uuid NOT NULL,
 native_instance_id uuid NOT NULL,session_fingerprint text NOT NULL CHECK(session_fingerprint ~ '^[a-f0-9]{64}$'),
 origin_role_name name NOT NULL REFERENCES history_origin_engine_roles(role_name),
 session_generation uuid NOT NULL DEFAULT gen_random_uuid(),policy_revision bigint NOT NULL,
 source_revision bigint NOT NULL CHECK(source_revision BETWEEN 1 AND 9007199254740991),
 engine_id text NOT NULL,engine_generation bigint NOT NULL,engine_fingerprint text NOT NULL,run_id uuid NOT NULL,
 scope jsonb NOT NULL,binding jsonb NOT NULL,history_scope_key text NOT NULL UNIQUE,live_scope_key text NOT NULL UNIQUE,
 state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','REVOKED')),
 owner_proof jsonb CHECK(owner_proof IS NULL OR jsonb_typeof(owner_proof)='object' AND octet_length(owner_proof::text)<=2048),
 created_at timestamptz NOT NULL DEFAULT now(),last_polled_at timestamptz,
 UNIQUE(organization_id,id),FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id),
 FOREIGN KEY(organization_id,channel_id,run_id) REFERENCES history_sync_runs(organization_id,channel_id,id)
);
CREATE UNIQUE INDEX history_source_one_active ON history_source_sessions(organization_id,channel_id) WHERE state='ACTIVE';
CREATE INDEX history_source_run ON history_source_sessions(organization_id,run_id);
ALTER TABLE history_origin_engine_roles ENABLE ROW LEVEL SECURITY;ALTER TABLE history_origin_engine_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY history_origin_roles_migrator ON history_origin_engine_roles TO jrc_migrator USING(true) WITH CHECK(true);
ALTER TABLE history_sync_connection_policies ENABLE ROW LEVEL SECURITY;ALTER TABLE history_sync_connection_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY history_policy_tenant ON history_sync_connection_policies TO jrc_app
 USING(organization_id=nullif(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK(organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY history_policy_migrator ON history_sync_connection_policies TO jrc_migrator USING(true) WITH CHECK(true);
ALTER TABLE history_source_sessions ENABLE ROW LEVEL SECURITY;ALTER TABLE history_source_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY history_source_tenant ON history_source_sessions FOR SELECT TO jrc_app USING(organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY history_source_poll ON history_source_sessions FOR UPDATE TO jrc_app
 USING(organization_id=nullif(current_setting('app.organization_id',true),'')::uuid) WITH CHECK(organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY history_source_migrator ON history_source_sessions TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON history_origin_engine_roles,history_sync_connection_policies,history_source_sessions FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle,jrc_origin;
GRANT SELECT ON history_sync_connection_policies,history_source_sessions TO jrc_app;
GRANT UPDATE(enabled,revision) ON history_sync_connection_policies TO jrc_app;
GRANT UPDATE(last_polled_at) ON history_source_sessions TO jrc_app;
--> statement-breakpoint
CREATE FUNCTION history_source_canonical(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public AS $$
 SELECT CASE jsonb_typeof(value)
 WHEN 'object' THEN '{'||coalesce((SELECT string_agg(to_jsonb(key)::text||':'||public.history_source_canonical(item),',' ORDER BY key COLLATE "C") FROM jsonb_each(value) AS e(key,item)),'')||'}'
 WHEN 'array' THEN '['||coalesce((SELECT string_agg(public.history_source_canonical(item),',' ORDER BY n) FROM jsonb_array_elements(value) WITH ORDINALITY AS e(item,n)),'')||']'
 ELSE value::text END
$$;
REVOKE ALL ON FUNCTION history_source_canonical(jsonb) FROM PUBLIC;
CREATE FUNCTION history_register_origin_engine(role_id text,engine text,gen bigint,fingerprint text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF session_user<>'jrc_migrator' AND current_setting('role',true) IS DISTINCT FROM 'jrc_migrator' THEN RAISE EXCEPTION 'HISTORY_SOURCE_REGISTRATION_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_id AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole)
   OR NOT pg_has_role(role_id,'jrc_origin','MEMBER') THEN RAISE EXCEPTION 'HISTORY_SOURCE_ROLE_INVALID';END IF;
 INSERT INTO public.history_origin_engine_roles(role_name,engine_id,generation,engine_fingerprint) VALUES(role_id::name,engine,gen,fingerprint)
 ON CONFLICT(role_name) DO UPDATE SET engine_id=EXCLUDED.engine_id,generation=EXCLUDED.generation,engine_fingerprint=EXCLUDED.engine_fingerprint,enabled=true;
END $$;
REVOKE ALL ON FUNCTION history_register_origin_engine(text,text,bigint,text) FROM PUBLIC;
CREATE FUNCTION history_origin_host_identity() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.history_origin_engine_roles%ROWTYPE;
BEGIN
 SELECT * INTO r FROM public.history_origin_engine_roles WHERE role_name=session_user AND enabled FOR SHARE;
 IF NOT FOUND OR NOT pg_has_role(session_user,'jrc_origin','MEMBER') THEN RAISE EXCEPTION 'HISTORY_SOURCE_HOST_UNREGISTERED' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('engineId',r.engine_id,'generation',r.generation,'engineFingerprint',r.engine_fingerprint);
END $$;
REVOKE ALL ON FUNCTION history_origin_host_identity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION history_origin_host_identity() TO jrc_origin;
--> statement-breakpoint
CREATE FUNCTION history_source_actor_current(org uuid,actor uuid,control_key uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF actor IS NOT NULL AND control_key IS NULL THEN
  PERFORM 1 FROM public.memberships WHERE organization_id=org AND user_id=actor AND role IN ('OWNER','ADMIN') FOR SHARE;
 ELSIF actor IS NULL AND control_key IS NOT NULL THEN
  PERFORM 1 FROM public.api_keys k JOIN public.chatwoot_control_bindings b ON b.organization_id=k.organization_id AND b.api_key_id=k.id
    JOIN public.chatwoot_accounts a ON a.organization_id=b.organization_id AND a.account_id=b.account_id
    JOIN public.chatwoot_destinations d ON d.organization_id=a.organization_id AND d.base_url=a.base_url AND d.revision=b.destination_revision
   WHERE k.organization_id=org AND k.id=control_key AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp())
    AND 'chatwoot:manage'=ANY(k.scopes) AND b.active AND a.status='READY' AND d.approval_status='APPROVED' FOR SHARE OF k,b,a,d;
 ELSE RAISE EXCEPTION 'HISTORY_SYNC_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'HISTORY_SYNC_FORBIDDEN' USING ERRCODE='42501';END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION history_source_actor_current(uuid,uuid,uuid) FROM PUBLIC;
CREATE FUNCTION history_sync_enable_connection(org uuid,channel uuid,actor uuid,request uuid,engine jsonb,control_key uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.history_sync_connection_policies%ROWTYPE;c public.messaging_channels%ROWTYPE;s public.qr_identity_scopes%ROWTYPE; iid uuid;
BEGIN
 PERFORM public.evolution_require_tenant(org);
 PERFORM public.history_source_actor_current(org,actor,control_key);
 SELECT instance_id INTO iid FROM public.messaging_channels WHERE organization_id=org AND id=channel;
 PERFORM 1 FROM public.instances WHERE organization_id=org AND id=iid AND archived_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'HISTORY_SYNC_CHANNEL_UNAVAILABLE';END IF;
 SELECT * INTO c FROM public.messaging_channels WHERE organization_id=org AND id=channel AND instance_id=iid AND provider='BAILEYS'
  AND transport='BROKER_TRANSPORT' AND deleting_at IS NULL FOR NO KEY UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'HISTORY_SYNC_CHANNEL_UNAVAILABLE';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.history_origin_engine_roles WHERE enabled AND engine_id=engine->>'engineId'
    AND generation=(engine->>'generation')::bigint AND engine_fingerprint=engine->>'destinationFingerprint')
   OR NOT public.evolution_assert_binding(org,iid,engine->>'engineId',(engine->>'generation')::bigint,engine->>'destinationFingerprint',(engine->>'traditional')::boolean,true)
 THEN RAISE EXCEPTION 'HISTORY_SOURCE_HOST_UNREGISTERED';END IF;
 -- New activation precedes pairing. Establish only the authenticated server
 -- binding here; a null owner cannot promote history or learn aliases.
 IF engine->>'qrBindingFingerprint' ~ '^[a-f0-9]{64}$' THEN
  INSERT INTO public.qr_identity_scopes(organization_id,channel_id,instance_id,upstream_instance_key,binding_fingerprint)
   SELECT org,channel,iid,i.upstream_instance_key,engine->>'qrBindingFingerprint' FROM public.instances i WHERE i.organization_id=org AND i.id=iid
   ON CONFLICT(organization_id,channel_id) DO NOTHING;
 END IF;
 SELECT * INTO s FROM public.qr_identity_scopes WHERE organization_id=org AND channel_id=channel AND instance_id=iid FOR SHARE;
 IF NOT FOUND OR engine->>'qrBindingFingerprint' IS NOT NULL AND s.binding_fingerprint<>engine->>'qrBindingFingerprint'
  THEN RAISE EXCEPTION 'HISTORY_SYNC_IDENTITY_UNAVAILABLE';END IF;
 INSERT INTO public.history_sync_connection_policies(organization_id,channel_id,instance_id,created_by,created_api_key_id,activation_id,engine_id,engine_generation,engine_fingerprint,binding_fingerprint)
 VALUES(org,channel,iid,actor,control_key,request,engine->>'engineId',(engine->>'generation')::bigint,engine->>'destinationFingerprint',s.binding_fingerprint) ON CONFLICT DO NOTHING;
 SELECT * INTO p FROM public.history_sync_connection_policies WHERE organization_id=org AND channel_id=channel FOR UPDATE;
 IF p.activation_id<>request OR p.instance_id<>iid OR p.binding_fingerprint<>s.binding_fingerprint OR NOT p.enabled THEN RAISE EXCEPTION 'HISTORY_SYNC_ADMISSION_CONFLICT';END IF;
 RETURN jsonb_build_object('schemaVersion',2,'organizationId',org,'channelId',channel,'enabled',p.enabled,'groupsMode',p.groups_mode,'revision',p.revision);
END $$;
REVOKE ALL ON FUNCTION history_sync_enable_connection(uuid,uuid,uuid,uuid,jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION history_sync_enable_connection(uuid,uuid,uuid,uuid,jsonb,uuid) TO jrc_app;
--> statement-breakpoint
CREATE FUNCTION history_source_assert(session_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.history_source_sessions%ROWTYPE;p public.history_sync_connection_policies%ROWTYPE;
BEGIN
 SELECT * INTO r FROM public.history_source_sessions WHERE id=session_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'HISTORY_SOURCE_SESSION_CHANGED';END IF;
 IF session_user='jrc_app' THEN PERFORM public.evolution_require_tenant(r.organization_id);
 ELSIF session_user<>r.origin_role_name THEN RAISE EXCEPTION 'HISTORY_SOURCE_SESSION_CHANGED' USING ERRCODE='42501';END IF;
 -- The Broker reader retains the same host-revocation fence as source capture.
 PERFORM 1 FROM public.history_origin_engine_roles e WHERE e.role_name=r.origin_role_name AND e.enabled AND e.engine_id=r.engine_id
  AND e.generation=r.engine_generation AND e.engine_fingerprint=r.engine_fingerprint
  AND pg_has_role(e.role_name,'jrc_origin','MEMBER') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'HISTORY_SOURCE_SESSION_CHANGED' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.organizations WHERE id=r.organization_id AND status='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'HISTORY_SOURCE_SESSION_CHANGED';END IF;
 PERFORM 1 FROM public.instances WHERE organization_id=r.organization_id AND id=r.instance_id AND archived_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'HISTORY_SOURCE_SESSION_CHANGED';END IF;
 PERFORM 1 FROM public.messaging_channels WHERE organization_id=r.organization_id AND id=r.channel_id AND instance_id=r.instance_id AND deleting_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'HISTORY_SOURCE_SESSION_CHANGED';END IF;
 -- Common lock order: instance, channel, identity, policy, source session.
 PERFORM 1 FROM public.qr_identity_scopes WHERE organization_id=r.organization_id AND channel_id=r.channel_id AND instance_id=r.instance_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'HISTORY_SOURCE_SESSION_CHANGED';END IF;
 SELECT * INTO p FROM public.history_sync_connection_policies WHERE organization_id=r.organization_id AND channel_id=r.channel_id FOR SHARE;
 IF NOT FOUND OR NOT p.enabled OR p.revision<>r.policy_revision OR p.engine_id<>r.engine_id OR p.engine_generation<>r.engine_generation
  OR p.engine_fingerprint<>r.engine_fingerprint THEN RAISE EXCEPTION 'HISTORY_SOURCE_SESSION_CHANGED';END IF;
 PERFORM public.history_source_actor_current(p.organization_id,p.created_by,p.created_api_key_id);
 PERFORM 1 FROM public.qr_identity_scopes WHERE organization_id=r.organization_id AND channel_id=r.channel_id AND instance_id=r.instance_id AND binding_fingerprint=p.binding_fingerprint FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'HISTORY_SOURCE_SESSION_CHANGED';END IF;
 PERFORM 1 FROM public.history_source_sessions WHERE id=session_id AND state='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'HISTORY_SOURCE_SESSION_CHANGED';END IF;
 IF EXISTS(SELECT 1 FROM public.evolution_engines) THEN
  PERFORM 1 FROM public.evolution_instance_bindings b JOIN public.evolution_engines e ON e.id=b.engine_id
   WHERE b.organization_id=r.organization_id AND b.instance_id=r.instance_id AND b.engine_id=r.engine_id AND b.generation=r.engine_generation AND b.destination_fingerprint=r.engine_fingerprint
    AND e.generation=b.generation AND e.destination_fingerprint=b.destination_fingerprint AND e.state<>'DISABLED' FOR SHARE OF b,e;
  IF NOT FOUND THEN RAISE EXCEPTION 'HISTORY_SOURCE_SESSION_CHANGED';END IF;
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION history_source_assert(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION history_source_assert(uuid) TO jrc_origin,jrc_app;
CREATE FUNCTION history_source_bind_owner(session_id uuid,proof jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE previous jsonb;
BEGIN
 IF session_user='jrc_app' THEN RAISE EXCEPTION 'HISTORY_SOURCE_OWNER_FORBIDDEN' USING ERRCODE='42501';END IF;
 -- Acquire before SHARE: concurrent owner observations cannot deadlock on an upgrade.
 PERFORM pg_advisory_xact_lock(hashtextextended(session_id::text,6112));
 PERFORM public.history_source_assert(session_id);
 IF jsonb_typeof(proof) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(proof))<>3
  OR NOT(proof ?& ARRAY['iv','tag','ciphertext']) OR octet_length(proof::text)>2048
  OR jsonb_typeof(proof->'iv') IS DISTINCT FROM 'string' OR jsonb_typeof(proof->'tag') IS DISTINCT FROM 'string' OR jsonb_typeof(proof->'ciphertext') IS DISTINCT FROM 'string'
  OR octet_length(decode(proof->>'iv','base64'))<>12 OR octet_length(decode(proof->>'tag','base64'))<>16
  OR octet_length(decode(proof->>'ciphertext','base64')) NOT BETWEEN 1 AND 512 THEN RAISE EXCEPTION 'HISTORY_SOURCE_OWNER_INVALID';END IF;
 SELECT owner_proof INTO previous FROM public.history_source_sessions WHERE id=session_id;
 IF previous IS NOT NULL AND previous<>proof THEN RAISE EXCEPTION 'HISTORY_SOURCE_OWNER_CHANGED';END IF;
 IF previous IS NULL THEN UPDATE public.history_source_sessions SET owner_proof=proof WHERE id=session_id;END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION history_source_bind_owner(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION history_source_bind_owner(uuid,jsonb) TO jrc_origin;
CREATE FUNCTION history_source_owner(session_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE proof jsonb;BEGIN
 IF session_user='jrc_app' THEN RAISE EXCEPTION 'HISTORY_SOURCE_OWNER_FORBIDDEN' USING ERRCODE='42501';END IF;
 PERFORM public.history_source_assert(session_id);
 SELECT owner_proof INTO proof FROM public.history_source_sessions WHERE id=session_id;
 RETURN proof;
END $$;
REVOKE ALL ON FUNCTION history_source_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION history_source_owner(uuid) TO jrc_origin;
--> statement-breakpoint
CREATE FUNCTION history_source_open(instance_name text,native_id uuid,session_fingerprint text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE h jsonb;p public.history_sync_connection_policies%ROWTYPE;r public.history_source_sessions%ROWTYPE;
 sid uuid;run uuid;epoch uuid;source_rev bigint;capture jsonb;native_binding jsonb;history_key text;live_key text;
BEGIN
 h:=public.history_origin_host_identity();
 IF session_fingerprint IS NULL OR session_fingerprint !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'HISTORY_SOURCE_SESSION_INVALID';END IF;
 IF (SELECT count(*) FROM public.history_sync_connection_policies p0 JOIN public.instances i ON i.organization_id=p0.organization_id AND i.id=p0.instance_id
   WHERE i.upstream_instance_key=instance_name AND p0.engine_id=h->>'engineId' AND p0.enabled)>1 THEN RAISE EXCEPTION 'HISTORY_SOURCE_BINDING_AMBIGUOUS';END IF;
 SELECT p0.* INTO p FROM public.history_sync_connection_policies p0 JOIN public.instances i ON i.organization_id=p0.organization_id AND i.id=p0.instance_id
  WHERE i.upstream_instance_key=instance_name AND p0.engine_id=h->>'engineId' AND p0.enabled;
 IF NOT FOUND THEN RETURN jsonb_build_object('mode','LEGACY');END IF;
 PERFORM 1 FROM public.instances WHERE organization_id=p.organization_id AND id=p.instance_id AND upstream_instance_key=instance_name AND archived_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'HISTORY_SOURCE_SESSION_CHANGED';END IF;
 PERFORM 1 FROM public.messaging_channels WHERE organization_id=p.organization_id AND id=p.channel_id AND instance_id=p.instance_id AND deleting_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'HISTORY_SOURCE_SESSION_CHANGED';END IF;
 PERFORM 1 FROM public.qr_identity_scopes WHERE organization_id=p.organization_id AND channel_id=p.channel_id AND instance_id=p.instance_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'HISTORY_SOURCE_SESSION_CHANGED';END IF;
 SELECT * INTO p FROM public.history_sync_connection_policies WHERE organization_id=p.organization_id AND channel_id=p.channel_id FOR UPDATE;
 IF NOT p.enabled OR p.engine_generation<>(h->>'generation')::bigint OR p.engine_fingerprint<>h->>'engineFingerprint' THEN RAISE EXCEPTION 'HISTORY_SOURCE_SESSION_CHANGED';END IF;
 SELECT * INTO r FROM public.history_source_sessions WHERE organization_id=p.organization_id AND channel_id=p.channel_id AND state='ACTIVE' FOR UPDATE;
 IF FOUND AND r.origin_role_name=session_user AND r.native_instance_id=native_id AND r.session_fingerprint=history_source_open.session_fingerprint AND r.policy_revision=p.revision THEN
  PERFORM public.history_source_assert(r.id);
  RETURN jsonb_build_object('mode','CAPTURE','sessionId',r.id,'runId',r.run_id,'scope',r.scope,'binding',r.binding,'historyScopeKey',r.history_scope_key,'liveScopeKey',r.live_scope_key);
 END IF;
 IF r.id IS NOT NULL THEN
  UPDATE public.history_source_sessions SET state='REVOKED' WHERE id=r.id;
  UPDATE public.history_sync_runs SET state='BLOCKED',capture=CASE WHEN history_account_identity IS NULL THEN 'WAITING_IDENTITY' ELSE 'BLOCKED' END,last_error='HISTORY_SOURCE_SESSION_CHANGED',revision=revision+1 WHERE organization_id=p.organization_id AND id=r.run_id AND state IN ('RUNNING','PAUSED','PARTIAL');
 END IF;
 sid:=gen_random_uuid();run:=gen_random_uuid();epoch:=gen_random_uuid();
 SELECT coalesce(max(source_revision),0)+1 INTO source_rev FROM public.history_source_sessions WHERE organization_id=p.organization_id AND channel_id=p.channel_id;
 capture:=jsonb_build_object('organizationId',p.organization_id,'channelId',p.channel_id,'instanceId',p.instance_id,'engineId',p.engine_id,'engineGeneration',p.engine_generation,
  'sessionGeneration',epoch,'bindingFingerprint',p.binding_fingerprint,'identityScopeId',NULL,'historyAccountIdentity',NULL,'ownerFingerprint',NULL);
 native_binding:=jsonb_build_object('instanceId',native_id,'instanceName',instance_name,'generation',p.engine_generation,'destinationId',p.channel_id,'revision',source_rev);
 history_key:=encode(public.digest(public.history_source_canonical(capture),'sha256'),'hex');
 live_key:=encode(public.digest(public.history_source_canonical(jsonb_build_array(native_id,p.engine_generation,p.channel_id,source_rev)),'sha256'),'hex');
 INSERT INTO public.history_sync_runs(organization_id,id,channel_id,instance_id,request_id,request_hash,engine_id,engine_generation,session_generation,binding_fingerprint,categories)
 VALUES(p.organization_id,run,p.channel_id,p.instance_id,sid,encode(public.digest(sid::text,'sha256'),'hex'),p.engine_id,p.engine_generation,epoch,p.binding_fingerprint,ARRAY['INDIVIDUAL','GROUP','MEDIA']);
 INSERT INTO public.history_source_sessions(id,organization_id,channel_id,instance_id,native_instance_id,origin_role_name,session_fingerprint,session_generation,policy_revision,source_revision,engine_id,engine_generation,engine_fingerprint,run_id,scope,binding,history_scope_key,live_scope_key)
 VALUES(sid,p.organization_id,p.channel_id,p.instance_id,native_id,session_user,history_source_open.session_fingerprint,epoch,p.revision,source_rev,p.engine_id,p.engine_generation,p.engine_fingerprint,run,capture,native_binding,history_key,live_key);
 PERFORM public.history_source_assert(sid);
 RETURN jsonb_build_object('mode','CAPTURE','sessionId',sid,'runId',run,'scope',capture,'binding',native_binding,'historyScopeKey',history_key,'liveScopeKey',live_key);
END $$;
REVOKE ALL ON FUNCTION history_source_open(text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION history_source_open(text,uuid,text) TO jrc_origin;
--> statement-breakpoint
DO $$ DECLARE original text;patched text;BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 patched=replace(original,'DELETE FROM public.history_sync_receipts WHERE organization_id=org AND channel_id=channel;',
 'DELETE FROM public.history_source_sessions WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.history_sync_connection_policies WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.history_sync_receipts WHERE organization_id=org AND channel_id=channel;');
 IF patched=original THEN RAISE EXCEPTION 'HISTORY_SOURCE_PURGE_UPGRADE_MISMATCH';END IF;EXECUTE patched;
END $$;
