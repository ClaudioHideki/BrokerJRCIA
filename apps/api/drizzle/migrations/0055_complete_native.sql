-- CANDIDATE ONLY. Reserved after 0053 Flow + 0054 G3. Not registered/applied.
-- No resolver: native read/complete reuses credential audience from 0053.
-- No purge job; lifecycle incorporation and real PostgreSQL gates pending.
CREATE TABLE flow_native_registration_challenges (
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),
 credential_id uuid NOT NULL,credential_revision integer NOT NULL CHECK(credential_revision>0),
 destination_origin text NOT NULL,account_id bigint NOT NULL CHECK(account_id>0),
 destination_revision integer NOT NULL CHECK(destination_revision>0),account_credential_version integer NOT NULL CHECK(account_credential_version>0),
 transfer_nonce_hash text NOT NULL UNIQUE CHECK(transfer_nonce_hash ~ '^[a-f0-9]{64}$'),
 verification_nonce uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 callback_digest text CHECK(callback_digest ~ '^[a-f0-9]{64}$'),
 tuple jsonb NOT NULL CHECK(jsonb_typeof(tuple)='object'),
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','VERIFYING','COMMITTED','CANCELED')),
 created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 issuer_auth_version integer NOT NULL CHECK(issuer_auth_version>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 consumed_at timestamptz,revoked_at timestamptz,registration_id uuid,
 PRIMARY KEY(organization_id,id),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes'),
 CHECK((state='COMMITTED')=(consumed_at IS NOT NULL AND registration_id IS NOT NULL)),
 CHECK(state NOT IN ('VERIFYING','COMMITTED') OR callback_digest IS NOT NULL),
 CHECK(state<>'PENDING' OR callback_digest IS NULL),
 CHECK(state<>'CANCELED' OR revoked_at IS NOT NULL),
 FOREIGN KEY(organization_id,credential_id) REFERENCES flow_delegation_credentials(organization_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,destination_origin) REFERENCES chatwoot_destinations(organization_id,base_url) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id) REFERENCES chatwoot_accounts(organization_id) ON DELETE RESTRICT
);
CREATE TABLE flow_native_registration_targets (
 organization_id uuid NOT NULL,challenge_id uuid NOT NULL,integration_id uuid NOT NULL,channel_id uuid NOT NULL,
 inbox_id bigint NOT NULL CHECK(inbox_id>0),transport text NOT NULL CHECK(transport IN ('BROKER_TRANSPORT','CENTRAL_TRANSPORT')),
 provider text CHECK(provider='BAILEYS'),
 PRIMARY KEY(organization_id,challenge_id,integration_id),UNIQUE(organization_id,challenge_id,inbox_id),
 FOREIGN KEY(organization_id,challenge_id) REFERENCES flow_native_registration_challenges(organization_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,integration_id) REFERENCES chatwoot_connections(organization_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id) ON DELETE RESTRICT
);
CREATE TABLE flow_native_registrations (
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),challenge_id uuid NOT NULL,
 credential_id uuid NOT NULL,credential_revision integer NOT NULL CHECK(credential_revision>0),
 destination_origin text NOT NULL,account_id bigint NOT NULL CHECK(account_id>0),
 destination_revision integer NOT NULL CHECK(destination_revision>0),account_credential_version integer NOT NULL CHECK(account_credential_version>0),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 callback_ciphertext text,callback_key_version integer NOT NULL CHECK(callback_key_version>0),
 callback_purpose text NOT NULL DEFAULT 'FLOW_NATIVE_CALLBACK' CHECK(callback_purpose='FLOW_NATIVE_CALLBACK'),
 created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,issuer_auth_version integer NOT NULL CHECK(issuer_auth_version>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,revoked_at timestamptz,
 PRIMARY KEY(organization_id,id),UNIQUE(organization_id,challenge_id),
 CHECK(expires_at>created_at),CHECK((revoked_at IS NULL)=(callback_ciphertext IS NOT NULL)),
 FOREIGN KEY(organization_id,challenge_id) REFERENCES flow_native_registration_challenges(organization_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,credential_id) REFERENCES flow_delegation_credentials(organization_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,destination_origin) REFERENCES chatwoot_destinations(organization_id,base_url) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id) REFERENCES chatwoot_accounts(organization_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX flow_native_one_active_account ON flow_native_registrations(organization_id,destination_origin,account_id) WHERE revoked_at IS NULL;
ALTER TABLE flow_native_registration_challenges ADD CONSTRAINT flow_native_challenge_registration_fk
 FOREIGN KEY(organization_id,registration_id) REFERENCES flow_native_registrations(organization_id,id) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE FUNCTION flow_native_challenge_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF (NEW.organization_id,NEW.id,NEW.credential_id,NEW.credential_revision,NEW.destination_origin,NEW.account_id,
     NEW.destination_revision,NEW.account_credential_version,NEW.transfer_nonce_hash,NEW.verification_nonce,NEW.tuple,
     NEW.created_by,NEW.issuer_auth_version,NEW.created_at,NEW.expires_at)
  IS DISTINCT FROM
    (OLD.organization_id,OLD.id,OLD.credential_id,OLD.credential_revision,OLD.destination_origin,OLD.account_id,
     OLD.destination_revision,OLD.account_credential_version,OLD.transfer_nonce_hash,OLD.verification_nonce,OLD.tuple,
     OLD.created_by,OLD.issuer_auth_version,OLD.created_at,OLD.expires_at) THEN
  RAISE EXCEPTION 'FLOW_REGISTRATION_CHALLENGE_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 IF OLD.callback_digest IS NOT NULL AND NEW.callback_digest IS DISTINCT FROM OLD.callback_digest THEN
  RAISE EXCEPTION 'FLOW_REGISTRATION_CALLBACK_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 IF OLD.state IN ('COMMITTED','CANCELED') AND NEW.state<>OLD.state THEN
  RAISE EXCEPTION 'FLOW_REGISTRATION_CHALLENGE_TERMINAL' USING ERRCODE='23514';
 END IF;
 IF OLD.state='VERIFYING' AND NEW.state='PENDING' THEN
  RAISE EXCEPTION 'FLOW_REGISTRATION_CHALLENGE_REPLAY' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION flow_native_challenge_immutable() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION flow_native_challenge_immutable() FROM PUBLIC,jrc_auth,jrc_app,jrc_platform;
CREATE TRIGGER flow_native_challenge_immutable BEFORE UPDATE ON flow_native_registration_challenges
 FOR EACH ROW EXECUTE FUNCTION flow_native_challenge_immutable();
--> statement-breakpoint
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['flow_native_registration_challenges','flow_native_registration_targets','flow_native_registrations'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO jrc_migrator',tab);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO jrc_app USING(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',tab);
  EXECUTE format('CREATE POLICY lifecycle_migrator ON %I TO jrc_migrator USING(true) WITH CHECK(true)',tab);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth,jrc_platform',tab);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO jrc_app',tab);
 END LOOP;
END $$;
-- Snapshot children cannot be changed after insertion by jrc_app.
REVOKE UPDATE ON flow_native_registration_targets FROM jrc_app;
-- Deliberately no DELETE grant, cascade, purge catalogue bypass or fake drain.

--> statement-breakpoint
-- Appended to the unapplied registration0055; never edits0053 or0054.
CREATE TABLE flow_native_installation_grants (
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),registration_id uuid NOT NULL,
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0),tuple jsonb NOT NULL,tuple_digest text NOT NULL CHECK(tuple_digest~'^[a-f0-9]{64}$'),
 destination_origin text NOT NULL,account_id bigint NOT NULL CHECK(account_id>0),destination_revision integer NOT NULL CHECK(destination_revision>0),account_credential_version integer NOT NULL CHECK(account_credential_version>0),
 created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,issuer_auth_version integer NOT NULL CHECK(issuer_auth_version>=0),
 host_callback_ciphertext text,host_callback_key_version integer CHECK(host_callback_key_version>0),token_hash text UNIQUE CHECK(token_hash~'^[a-f0-9]{64}$'),
 transfer_nonce_hash text NOT NULL UNIQUE CHECK(transfer_nonce_hash~'^[a-f0-9]{64}$'),transfer_expires_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','ACTIVE','REVOKED')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),claimed_at timestamptz,revoked_at timestamptz,
 current_credential_id uuid NOT NULL,current_registration_id uuid NOT NULL,
 PRIMARY KEY(organization_id,id),
 FOREIGN KEY(organization_id,registration_id) REFERENCES flow_native_registrations(organization_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,current_registration_id) REFERENCES flow_native_registrations(organization_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,current_credential_id) REFERENCES flow_delegation_credentials(organization_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,destination_origin) REFERENCES chatwoot_destinations(organization_id,base_url) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id) REFERENCES chatwoot_accounts(organization_id) ON DELETE RESTRICT,
 CHECK(jsonb_typeof(tuple)='object'),CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 days'),
 CHECK(transfer_expires_at>created_at AND transfer_expires_at<=created_at+interval '5 minutes'),
 CHECK((state='ACTIVE')=(claimed_at IS NOT NULL AND revoked_at IS NULL AND token_hash IS NOT NULL AND host_callback_ciphertext IS NOT NULL AND host_callback_key_version IS NOT NULL)),
 CHECK(state<>'PENDING' OR (token_hash IS NULL AND host_callback_ciphertext IS NULL AND claimed_at IS NULL)),
 CHECK(state<>'REVOKED' OR (token_hash IS NULL AND host_callback_ciphertext IS NULL AND host_callback_key_version IS NULL AND revoked_at IS NOT NULL))
);
CREATE TABLE flow_native_installation_operations (
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),grant_id uuid NOT NULL,operation_nonce uuid NOT NULL UNIQUE,
 expected_generation integer NOT NULL CHECK(expected_generation>0),kind text NOT NULL CHECK(kind IN ('CLAIM','RENEW','REVOKE')),
 request_digest text NOT NULL CHECK(request_digest~'^[a-f0-9]{64}$'),proof_nonce uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','VERIFYING','COMMITTED','CANCELED','UNKNOWN')),lease_until timestamptz,
 previous_credential_id uuid,previous_registration_id uuid,new_credential_id uuid,new_registration_id uuid,
 response_ciphertext text,response_key_version integer CHECK(response_key_version>0),recovery_expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),committed_at timestamptz,revoked_at timestamptz,
 PRIMARY KEY(organization_id,id),FOREIGN KEY(organization_id,grant_id) REFERENCES flow_native_installation_grants(organization_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,previous_credential_id) REFERENCES flow_delegation_credentials(organization_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,new_credential_id) REFERENCES flow_delegation_credentials(organization_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,previous_registration_id) REFERENCES flow_native_registrations(organization_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,new_registration_id) REFERENCES flow_native_registrations(organization_id,id) ON DELETE RESTRICT,
 CHECK((state='COMMITTED')=(committed_at IS NOT NULL)),CHECK((response_ciphertext IS NULL)=(response_key_version IS NULL)),
 CHECK(recovery_expires_at<=created_at+interval '5 minutes')
);
CREATE UNIQUE INDEX flow_installation_single_operation ON flow_native_installation_operations(organization_id,grant_id,expected_generation) WHERE kind IN ('CLAIM','RENEW') AND state IN ('PENDING','VERIFYING','UNKNOWN');
CREATE TABLE flow_native_installation_targets (
 organization_id uuid NOT NULL,grant_id uuid NOT NULL,integration_id uuid NOT NULL,channel_id uuid NOT NULL,inbox_id bigint NOT NULL CHECK(inbox_id>0),
 transport text NOT NULL CHECK(transport IN ('BROKER_TRANSPORT','CENTRAL_TRANSPORT')),provider text CHECK(provider='BAILEYS'),
 PRIMARY KEY(organization_id,grant_id,integration_id),UNIQUE(organization_id,grant_id,inbox_id),
 FOREIGN KEY(organization_id,grant_id) REFERENCES flow_native_installation_grants(organization_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,integration_id) REFERENCES chatwoot_connections(organization_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id) ON DELETE RESTRICT
 ,CHECK((transport='CENTRAL_TRANSPORT' AND provider IS NULL) OR (transport='BROKER_TRANSPORT' AND provider IS NOT NULL))
);
--> statement-breakpoint
CREATE FUNCTION flow_installation_grant_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF (NEW.organization_id,NEW.id,NEW.registration_id,NEW.tuple,NEW.tuple_digest,NEW.destination_origin,NEW.account_id,NEW.destination_revision,NEW.account_credential_version,NEW.created_by,NEW.issuer_auth_version,NEW.transfer_nonce_hash,NEW.created_at,NEW.transfer_expires_at,NEW.expires_at)
 IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.registration_id,OLD.tuple,OLD.tuple_digest,OLD.destination_origin,OLD.account_id,OLD.destination_revision,OLD.account_credential_version,OLD.created_by,OLD.issuer_auth_version,OLD.transfer_nonce_hash,OLD.created_at,OLD.transfer_expires_at,OLD.expires_at) THEN RAISE EXCEPTION 'FLOW_INSTALLATION_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF OLD.state='REVOKED' AND NEW.state<>'REVOKED' THEN RAISE EXCEPTION 'FLOW_INSTALLATION_TERMINAL' USING ERRCODE='23514'; END IF;
 IF NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1 THEN RAISE EXCEPTION 'FLOW_INSTALLATION_GENERATION' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER flow_installation_grant_immutable BEFORE UPDATE ON flow_native_installation_grants FOR EACH ROW EXECUTE FUNCTION flow_installation_grant_immutable();
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['flow_native_installation_grants','flow_native_installation_operations','flow_native_installation_targets'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO jrc_migrator',tab);EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO jrc_app USING(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',tab);
  EXECUTE format('CREATE POLICY lifecycle_migrator ON %I TO jrc_migrator USING(true) WITH CHECK(true)',tab);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth,jrc_platform',tab);EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO jrc_app',tab);
 END LOOP; END $$;
REVOKE UPDATE ON flow_native_installation_targets FROM jrc_app;
CREATE FUNCTION flow_installation_target_bound() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE approved jsonb; BEGIN
 SELECT tuple INTO approved FROM public.flow_native_installation_grants WHERE organization_id=NEW.organization_id AND id=NEW.grant_id FOR UPDATE;
 IF (SELECT count(*) FROM public.flow_native_installation_targets WHERE organization_id=NEW.organization_id AND grant_id=NEW.grant_id)>=100 OR NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(approved->'targets') t WHERE t->>'integrationId'=NEW.integration_id::text AND t->>'channelId'=NEW.channel_id::text AND (t->>'inboxId')::bigint=NEW.inbox_id AND t->>'transport'=NEW.transport AND (t->>'provider') IS NOT DISTINCT FROM NEW.provider)
 THEN RAISE EXCEPTION 'FLOW_INSTALLATION_TARGET_UNAPPROVED' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER flow_installation_target_bound BEFORE INSERT ON flow_native_installation_targets FOR EACH ROW EXECUTE FUNCTION flow_installation_target_bound();
ALTER FUNCTION flow_installation_target_bound() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION flow_installation_target_bound() FROM PUBLIC,jrc_auth,jrc_app,jrc_platform;
CREATE FUNCTION flow_installation_operation_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF (NEW.organization_id,NEW.id,NEW.grant_id,NEW.operation_nonce,NEW.expected_generation,NEW.kind,NEW.request_digest,NEW.proof_nonce,NEW.previous_credential_id,NEW.previous_registration_id,NEW.created_at,NEW.recovery_expires_at)
 IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.grant_id,OLD.operation_nonce,OLD.expected_generation,OLD.kind,OLD.request_digest,OLD.proof_nonce,OLD.previous_credential_id,OLD.previous_registration_id,OLD.created_at,OLD.recovery_expires_at)
 THEN RAISE EXCEPTION 'FLOW_INSTALLATION_OPERATION_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF OLD.state IN ('COMMITTED','CANCELED') AND NEW.state<>OLD.state THEN RAISE EXCEPTION 'FLOW_INSTALLATION_OPERATION_TERMINAL' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER flow_installation_operation_immutable BEFORE UPDATE ON flow_native_installation_operations FOR EACH ROW EXECUTE FUNCTION flow_installation_operation_immutable();
ALTER FUNCTION flow_installation_operation_immutable() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION flow_installation_operation_immutable() FROM PUBLIC,jrc_auth,jrc_app,jrc_platform;
ALTER FUNCTION flow_installation_grant_immutable() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION flow_installation_grant_immutable() FROM PUBLIC,jrc_auth,jrc_app,jrc_platform;
CREATE FUNCTION resolve_flow_installation_grant(value text) RETURNS uuid LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,public AS $$
 SELECT organization_id FROM public.flow_native_installation_grants WHERE token_hash=value AND state='ACTIVE' AND revoked_at IS NULL AND expires_at>statement_timestamp()
$$;
ALTER FUNCTION resolve_flow_installation_grant(text) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION resolve_flow_installation_grant(text) FROM PUBLIC,jrc_app,jrc_platform;
GRANT EXECUTE ON FUNCTION resolve_flow_installation_grant(text) TO jrc_auth;
-- Revoked grant tokens never regain normal authority. This exact request digest
-- can authorize only replay observation of a committed reduction for5minutes.
CREATE FUNCTION resolve_flow_installation_reduction(value text) RETURNS uuid LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,public AS $$
 SELECT o.organization_id FROM public.flow_native_installation_operations o JOIN public.flow_native_installation_grants g ON g.organization_id=o.organization_id AND g.id=o.grant_id
 WHERE o.kind='REVOKE' AND o.state='COMMITTED' AND o.request_digest=value AND o.recovery_expires_at>statement_timestamp()
 AND g.state='REVOKED' AND g.revoked_at IS NOT NULL AND g.token_hash IS NULL AND g.host_callback_ciphertext IS NULL
$$;
ALTER FUNCTION resolve_flow_installation_reduction(text) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION resolve_flow_installation_reduction(text) FROM PUBLIC,jrc_app,jrc_platform;
GRANT EXECUTE ON FUNCTION resolve_flow_installation_reduction(text) TO jrc_auth;
