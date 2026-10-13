-- REVIEW CANDIDATE ONLY. Not registered in the journal or applied to any DB.
-- Root assigns the migration number after the frozen release is complete.
-- Shared deployment evidence is independent of an individual tenant. A new
-- tenant/Account cannot declare the same verified native origin to be stock.
CREATE TABLE flow_executor_origins (
 base_url text PRIMARY KEY CHECK(base_url ~ '^https://[^/?#@]+$'),
 kind text NOT NULL CHECK(kind IN ('STOCK','JRC_NATIVE')),
 provenance text NOT NULL CHECK(provenance IN ('PLATFORM_DESTINATION_APPROVAL','AUTHENTICATED_JRC_BFF','VERIFIED_DEPLOYMENT')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 approval_audit_id uuid NOT NULL REFERENCES platform_audit_logs(id),
 verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),revoked_at timestamptz,
 host_source_sha text CHECK(host_source_sha ~ '^[a-f0-9]{40}$'),host_image_digest text CHECK(host_image_digest ~ '^sha256:[a-f0-9]{64}$'),
 fence_protocol_version integer CHECK(fence_protocol_version>0),
 CHECK((kind='STOCK' AND provenance='PLATFORM_DESTINATION_APPROVAL' AND host_source_sha IS NULL AND host_image_digest IS NULL AND fence_protocol_version IS NULL)
  OR (kind='JRC_NATIVE' AND provenance IN ('AUTHENTICATED_JRC_BFF','VERIFIED_DEPLOYMENT') AND host_source_sha IS NOT NULL AND host_image_digest IS NOT NULL AND fence_protocol_version IS NOT NULL))
);
ALTER TABLE flow_executor_origins OWNER TO jrc_migrator;
ALTER TABLE flow_executor_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_executor_origins FORCE ROW LEVEL SECURITY;
CREATE POLICY flow_origins_tenant_read ON flow_executor_origins FOR SELECT TO jrc_app
 USING(EXISTS(SELECT 1 FROM chatwoot_destinations d WHERE d.organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid
  AND d.base_url=flow_executor_origins.base_url AND d.approval_status='APPROVED'));
CREATE POLICY flow_origins_platform ON flow_executor_origins TO jrc_platform USING(true) WITH CHECK(true);
CREATE POLICY flow_origins_migrator ON flow_executor_origins TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON flow_executor_origins FROM PUBLIC,jrc_auth,jrc_app;
GRANT SELECT ON flow_executor_origins TO jrc_app;
GRANT SELECT,INSERT,UPDATE ON flow_executor_origins TO jrc_platform;
-- FOR SHARE itself requires UPDATE privilege in PostgreSQL. Keep the tenant
-- role read-only and acquire this lock through a context-bound definer instead.
CREATE FUNCTION lock_current_flow_origin_capability(p_origin text)
RETURNS TABLE(kind text,revision integer,revoked_at timestamptz,host_source_sha text,host_image_digest text,fence_protocol_version integer)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT c.kind,c.revision,c.revoked_at,c.host_source_sha,c.host_image_digest,c.fence_protocol_version
 FROM public.flow_executor_origins c JOIN public.chatwoot_destinations d ON d.base_url=c.base_url
 WHERE c.base_url=p_origin AND d.organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid
 AND d.approval_status='APPROVED' FOR SHARE OF c
$$;
ALTER FUNCTION lock_current_flow_origin_capability(text) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lock_current_flow_origin_capability(text) FROM PUBLIC,jrc_auth,jrc_platform;
GRANT EXECUTE ON FUNCTION lock_current_flow_origin_capability(text) TO jrc_app;
CREATE FUNCTION prevent_flow_origin_native_downgrade() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.kind='JRC_NATIVE' AND NEW.kind<>'JRC_NATIVE' THEN
  RAISE EXCEPTION 'FLOW_ORIGIN_NATIVE_DOWNGRADE_FORBIDDEN' USING ERRCODE='23514',CONSTRAINT='flow_origin_native_downgrade';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION prevent_flow_origin_native_downgrade() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION prevent_flow_origin_native_downgrade() FROM PUBLIC;
CREATE TRIGGER flow_origin_native_downgrade BEFORE UPDATE ON flow_executor_origins FOR EACH ROW EXECUTE FUNCTION prevent_flow_origin_native_downgrade();
--> statement-breakpoint
CREATE TABLE flow_delegation_credentials (
 organization_id uuid NOT NULL REFERENCES organizations(id),id uuid NOT NULL DEFAULT gen_random_uuid(),
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 destination_origin text NOT NULL,account_id bigint NOT NULL CHECK(account_id>0),
 destination_revision integer NOT NULL CHECK(destination_revision>0),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 scopes text[] NOT NULL CHECK(cardinality(scopes) BETWEEN 1 AND 4 AND array_position(scopes,NULL) IS NULL
  AND scopes <@ ARRAY['flow:read','flow:edit','flow:publish','flow:bind']::text[]),
 created_by uuid NOT NULL REFERENCES users(id),issuer_auth_version integer NOT NULL CHECK(issuer_auth_version>=0),created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 expires_at timestamptz NOT NULL,revoked_at timestamptz,
 PRIMARY KEY(organization_id,id),CHECK(expires_at>created_at),
 FOREIGN KEY(organization_id) REFERENCES chatwoot_destinations(organization_id)
);
CREATE TABLE flow_delegation_sessions (
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),credential_id uuid,
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),nonce uuid NOT NULL UNIQUE,
 actor_kind text NOT NULL CHECK(actor_kind IN ('BROKER','JRC_NATIVE')),
 user_id uuid REFERENCES users(id),auth_version integer CHECK(auth_version>=0),
 external_actor_id text CHECK(external_actor_id ~ '^[A-Za-z0-9:_-]{1,80}$'),
 credential_revision integer CHECK(credential_revision>0),account_credential_version integer NOT NULL CHECK(account_credential_version>0),
 destination_origin text NOT NULL,account_id bigint NOT NULL CHECK(account_id>0),destination_revision integer NOT NULL CHECK(destination_revision>0),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),expires_at timestamptz NOT NULL,
 revoked_at timestamptz,PRIMARY KEY(organization_id,id),
 CHECK((actor_kind='BROKER' AND user_id IS NOT NULL AND auth_version IS NOT NULL AND credential_id IS NULL AND credential_revision IS NULL AND external_actor_id IS NULL)
  OR (actor_kind='JRC_NATIVE' AND user_id IS NULL AND auth_version IS NULL AND credential_id IS NOT NULL AND credential_revision IS NOT NULL AND external_actor_id IS NOT NULL)),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes'),
 FOREIGN KEY(organization_id,credential_id) REFERENCES flow_delegation_credentials(organization_id,id)
);
-- A snapshot of the mapping is retained, not inferred from a later binding.
-- Guard code compares it against the current Account/destination/connection.
CREATE TABLE flow_delegation_session_grants (
 organization_id uuid NOT NULL,session_id uuid NOT NULL,integration_id uuid NOT NULL,
 account_id bigint NOT NULL CHECK(account_id>0),inbox_id bigint NOT NULL CHECK(inbox_id>0),channel_id uuid NOT NULL,
 destination_revision integer NOT NULL CHECK(destination_revision>0),
 scopes text[] NOT NULL CHECK(cardinality(scopes) BETWEEN 1 AND 4 AND array_position(scopes,NULL) IS NULL
  AND scopes <@ ARRAY['flow:read','flow:edit','flow:publish','flow:bind']::text[]),
 PRIMARY KEY(organization_id,session_id,integration_id),
 FOREIGN KEY(organization_id,session_id) REFERENCES flow_delegation_sessions(organization_id,id),
 FOREIGN KEY(organization_id,integration_id) REFERENCES chatwoot_connections(organization_id,id),
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id)
);
CREATE TABLE flow_member_grants (
 organization_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES users(id),integration_id uuid NOT NULL,
 scopes text[] NOT NULL CHECK(cardinality(scopes)<=4 AND array_position(scopes,NULL) IS NULL
  AND scopes <@ ARRAY['flow:read','flow:edit','flow:publish','flow:bind']::text[]),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_by uuid NOT NULL REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(organization_id,user_id,integration_id),
 FOREIGN KEY(organization_id,integration_id) REFERENCES chatwoot_connections(organization_id,id)
);
CREATE TABLE flow_executor_profiles (
 organization_id uuid NOT NULL,integration_id uuid NOT NULL,host_kind text NOT NULL CHECK(host_kind IN ('STOCK','JRC_NATIVE')),
 destination_origin text NOT NULL REFERENCES flow_executor_origins(base_url),origin_capability_revision integer NOT NULL CHECK(origin_capability_revision>0),account_id bigint NOT NULL CHECK(account_id>0),inbox_id bigint NOT NULL CHECK(inbox_id>0),
 destination_revision integer NOT NULL CHECK(destination_revision>0),account_credential_version integer NOT NULL CHECK(account_credential_version>0),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),approved_by uuid NOT NULL REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(organization_id,integration_id),
 FOREIGN KEY(organization_id,integration_id) REFERENCES chatwoot_connections(organization_id,id)
);
ALTER TABLE automation_definitions ADD COLUMN delegation_scope_revision integer NOT NULL DEFAULT 0 CHECK(delegation_scope_revision>=0);
CREATE TABLE automation_definition_scopes (
 organization_id uuid NOT NULL,automation_id uuid NOT NULL,integration_id uuid NOT NULL,
 account_id bigint NOT NULL CHECK(account_id>0),inbox_id bigint NOT NULL CHECK(inbox_id>0),channel_id uuid NOT NULL,
 destination_revision integer NOT NULL CHECK(destination_revision>0),
 PRIMARY KEY(organization_id,automation_id,integration_id),
 FOREIGN KEY(organization_id,automation_id) REFERENCES automation_definitions(organization_id,id),
 FOREIGN KEY(organization_id,integration_id) REFERENCES chatwoot_connections(organization_id,id),
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id)
);
CREATE INDEX automation_scopes_inbox ON automation_definition_scopes(organization_id,integration_id,automation_id);
CREATE TABLE flow_executor_cutovers (
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),integration_id uuid NOT NULL,
 channel_id uuid NOT NULL,host_kind text NOT NULL CHECK(host_kind IN ('STOCK','JRC_NATIVE')),profile_revision integer NOT NULL CHECK(profile_revision>0),origin_capability_revision integer NOT NULL CHECK(origin_capability_revision>0),
 account_id bigint NOT NULL CHECK(account_id>0),inbox_id bigint NOT NULL CHECK(inbox_id>0),destination_revision integer NOT NULL CHECK(destination_revision>0),
 account_credential_version integer NOT NULL CHECK(account_credential_version>0),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),expected_owner_revision integer NOT NULL CHECK(expected_owner_revision>=0),
 phase text NOT NULL DEFAULT 'REQUESTED' CHECK(phase IN ('REQUESTED','FENCED','DRAINED','ACTIVATED','ROLLBACK_DRAINING','ROLLED_BACK','UNKNOWN')),
 host_fence_revision integer CHECK(host_fence_revision>0),admission_closed boolean NOT NULL DEFAULT false,
 live_runs integer CHECK(live_runs>=0),legacy_jobs integer CHECK(legacy_jobs>=0),uncertain_effects integer CHECK(uncertain_effects>=0),
 guarded_paths text[] NOT NULL DEFAULT '{}',proof_observed_at timestamptz,proof_valid_until timestamptz,
 lease_token uuid,lease_expires_at timestamptz,fence_dispatched_at timestamptz,qr_identity_revision integer,qr_identity_fingerprint text,
 remote_bot_id bigint,remote_bot_callback text,activated_owner_revision integer,binding_id uuid,automation_id uuid,
 host_source_sha text CHECK(host_source_sha ~ '^[a-f0-9]{40}$'),host_image_digest text CHECK(host_image_digest ~ '^sha256:[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(organization_id,integration_id),UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,integration_id) REFERENCES chatwoot_connections(organization_id,id),
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id),
 CHECK((lease_token IS NULL)=(lease_expires_at IS NULL)),
 CHECK(host_kind<>'STOCK' OR fence_dispatched_at IS NULL),
 CHECK(phase<>'REQUESTED' OR fence_dispatched_at IS NULL),
 CHECK(phase<>'FENCED' OR (host_kind='JRC_NATIVE' AND fence_dispatched_at IS NOT NULL)),
 CHECK(phase<>'DRAINED' OR (admission_closed
  AND proof_observed_at IS NOT NULL AND proof_valid_until IS NOT NULL AND proof_valid_until>proof_observed_at
  AND proof_valid_until<=proof_observed_at+interval '30 seconds' AND (
  (host_kind='STOCK' AND ((qr_identity_revision IS NOT NULL AND qr_identity_fingerprint IS NOT NULL AND remote_bot_id IS NULL)
    OR (remote_bot_id IS NOT NULL AND remote_bot_callback IS NOT NULL AND qr_identity_revision IS NULL)))
  OR (host_kind='JRC_NATIVE' AND fence_dispatched_at IS NOT NULL AND host_fence_revision IS NOT NULL AND host_fence_revision=revision
  AND live_runs IS NOT NULL AND live_runs=0 AND legacy_jobs IS NOT NULL AND legacy_jobs=0 AND uncertain_effects IS NOT NULL AND uncertain_effects=0
  AND host_source_sha IS NOT NULL AND host_image_digest IS NOT NULL
  AND cardinality(guarded_paths)=11 AND ARRAY['listener','dispatch','resume','recovery','workflow-turn','runner','workflow-runner',
   'remote-event','remote-resume','remote-recovery','remote-runner']::text[] <@ guarded_paths))))
);
--> statement-breakpoint
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['flow_delegation_credentials','flow_delegation_sessions','flow_delegation_session_grants',
  'automation_definition_scopes','flow_executor_cutovers','flow_member_grants','flow_executor_profiles'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO jrc_migrator',tab);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO jrc_app USING(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',tab);
  EXECUTE format('CREATE POLICY lifecycle_migrator ON %I TO jrc_migrator USING(true) WITH CHECK(true)',tab);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth,jrc_platform',tab);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO jrc_app',tab);
 END LOOP;
END $$;
--> statement-breakpoint
ALTER FUNCTION lifecycle_pending_count(uuid,uuid,uuid) RENAME TO lifecycle_pending_count_before_flow_delegation;
CREATE FUNCTION lifecycle_pending_count(p_org uuid,p_channel uuid,p_resource uuid)
RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.lifecycle_pending_count_before_flow_delegation(p_org,p_channel,p_resource)
 +(SELECT count(*) FROM public.flow_executor_cutovers c WHERE c.organization_id=p_org
   AND (p_channel IS NULL OR c.channel_id=p_channel) AND c.phase IN ('REQUESTED','FENCED','UNKNOWN','ROLLBACK_DRAINING'));
$$;
ALTER FUNCTION lifecycle_pending_count(uuid,uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_pending_count(uuid,uuid,uuid) FROM PUBLIC,jrc_auth,jrc_app,jrc_platform;
GRANT EXECUTE ON FUNCTION lifecycle_pending_count(uuid,uuid,uuid) TO jrc_lifecycle;
-- Preserve the complete predecessor chain (including private-media cleanup).
-- The admission callers already hold organization/instance/channel locks;
-- keep cutover rows locked until their existing safe-work cancellation ends.
ALTER FUNCTION lifecycle_cancel_safe_work(uuid,uuid) RENAME TO lifecycle_cancel_safe_work_before_flow_delegation;
CREATE FUNCTION lifecycle_cancel_safe_work(p_org uuid,p_channel uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF session_user<>'jrc_platform' THEN RAISE EXCEPTION 'LIFECYCLE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.flow_executor_cutovers WHERE organization_id=p_org
  AND (p_channel IS NULL OR channel_id=p_channel) ORDER BY integration_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.flow_executor_cutovers WHERE organization_id=p_org
  AND (p_channel IS NULL OR channel_id=p_channel) AND phase IN ('REQUESTED','FENCED','UNKNOWN','ROLLBACK_DRAINING')) THEN
  RAISE EXCEPTION 'LIFECYCLE_PENDING_WORK' USING ERRCODE='23514',CONSTRAINT='lifecycle_pending_work';
 END IF;
 PERFORM public.lifecycle_cancel_safe_work_before_flow_delegation(p_org,p_channel);
END $$;
ALTER FUNCTION lifecycle_cancel_safe_work(uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_cancel_safe_work(uuid,uuid),lifecycle_cancel_safe_work_before_flow_delegation(uuid,uuid)
 FROM PUBLIC,jrc_auth,jrc_app,jrc_platform,jrc_lifecycle;
DO $$ DECLARE original text; patched text; BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 patched=replace(original,'-- Remove the complete channel-owned execution tree before the binding or message it references.',
 'IF EXISTS(SELECT 1 FROM public.flow_executor_cutovers WHERE organization_id=org AND channel_id=channel
   AND phase IN (''REQUESTED'',''FENCED'',''UNKNOWN'',''ROLLBACK_DRAINING'')) THEN
   RAISE EXCEPTION ''CHANNEL_HAS_PENDING_WORK'' USING ERRCODE=''23514'',CONSTRAINT=''lifecycle_pending_work'';
  END IF;
  -- Remove the complete channel-owned execution tree before the binding or message it references.');
 IF patched=original THEN RAISE EXCEPTION 'FLOW_CUTOVER_CHANNEL_PURGE_PATCH_TARGET_MISSING'; END IF;EXECUTE patched;
 original=pg_get_functiondef('public.lifecycle_purge_organization(uuid,uuid)'::regprocedure);
 patched=replace(original,'-- Any newly introduced tenant table requires an explicit catalogue update before deletion.',
 'IF EXISTS(SELECT 1 FROM public.flow_executor_cutovers WHERE organization_id=org
   AND phase IN (''REQUESTED'',''FENCED'',''UNKNOWN'',''ROLLBACK_DRAINING'')) THEN
   RAISE EXCEPTION ''LIFECYCLE_PENDING_WORK'' USING ERRCODE=''23514'',CONSTRAINT=''lifecycle_pending_work'';
  END IF;
  -- Any newly introduced tenant table requires an explicit catalogue update before deletion.');
 IF patched=original THEN RAISE EXCEPTION 'FLOW_CUTOVER_ORGANIZATION_PURGE_PATCH_TARGET_MISSING'; END IF;EXECUTE patched;
END $$;
GRANT DELETE ON flow_delegation_session_grants,automation_definition_scopes TO jrc_app;
CREATE TRIGGER lifecycle_flow_session_grants_block BEFORE INSERT ON flow_delegation_session_grants
 FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_channel_write();
CREATE TRIGGER lifecycle_automation_definition_scopes_block BEFORE INSERT ON automation_definition_scopes
 FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_channel_write();
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('flow_delegation_credentials'),('flow_delegation_sessions'),
 ('flow_delegation_session_grants'),('automation_definition_scopes'),('flow_executor_cutovers'),('flow_member_grants'),('flow_executor_profiles');
--> statement-breakpoint
-- jrc_auth can discover only the tenant of a high-entropy credential digest.
-- App code still checks current expiry/revision/destination/scopes under RLS.
CREATE FUNCTION resolve_flow_delegation_credential(digest text) RETURNS uuid LANGUAGE sql VOLATILE
 SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT organization_id FROM public.flow_delegation_credentials
 WHERE token_hash=digest AND revoked_at IS NULL AND expires_at>clock_timestamp()
$$;
ALTER FUNCTION resolve_flow_delegation_credential(text) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION resolve_flow_delegation_credential(text) FROM PUBLIC,jrc_app,jrc_platform;
GRANT EXECUTE ON FUNCTION resolve_flow_delegation_credential(text) TO jrc_auth;
CREATE FUNCTION resolve_flow_delegation_session(digest text) RETURNS uuid LANGUAGE sql VOLATILE
 SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT organization_id FROM public.flow_delegation_sessions
 WHERE token_hash=digest AND revoked_at IS NULL AND expires_at>clock_timestamp()
$$;
ALTER FUNCTION resolve_flow_delegation_session(text) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION resolve_flow_delegation_session(text) FROM PUBLIC,jrc_app,jrc_platform;
GRANT EXECUTE ON FUNCTION resolve_flow_delegation_session(text) TO jrc_auth;
--> statement-breakpoint
DO $$ DECLARE original text; patched text; BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 patched=replace(original,'DELETE FROM public.chatwoot_connections WHERE organization_id=org AND channel_id=channel;',
 'UPDATE public.flow_delegation_sessions s SET revoked_at=clock_timestamp()
   WHERE s.organization_id=org AND EXISTS(SELECT 1 FROM public.flow_delegation_session_grants g
    WHERE g.organization_id=s.organization_id AND g.session_id=s.id AND g.channel_id=channel);
  UPDATE public.automation_definitions a SET delegation_scope_revision=delegation_scope_revision+1
   WHERE a.organization_id=org AND EXISTS(SELECT 1 FROM public.automation_definition_scopes ds
    WHERE ds.organization_id=a.organization_id AND ds.automation_id=a.id AND ds.channel_id=channel);
  DELETE FROM public.flow_delegation_session_grants WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.automation_definition_scopes WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.flow_executor_cutovers f USING public.chatwoot_connections c
   WHERE f.organization_id=org AND c.organization_id=f.organization_id AND c.id=f.integration_id AND c.channel_id=channel;
  DELETE FROM public.flow_member_grants f USING public.chatwoot_connections c
   WHERE f.organization_id=org AND c.organization_id=f.organization_id AND c.id=f.integration_id AND c.channel_id=channel;
  DELETE FROM public.flow_executor_profiles f USING public.chatwoot_connections c
   WHERE f.organization_id=org AND c.organization_id=f.organization_id AND c.id=f.integration_id AND c.channel_id=channel;
  DELETE FROM public.chatwoot_connections WHERE organization_id=org AND channel_id=channel;');
 IF patched=original THEN RAISE EXCEPTION 'FLOW_DELEGATION_PURGE_PATCH_TARGET_MISSING'; END IF;
 EXECUTE patched;
END $$;
