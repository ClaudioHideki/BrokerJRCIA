-- Source journal in the Broker database. No Evolution session/auth table is moved.
CREATE SCHEMA IF NOT EXISTS jrc_evolution_origin;
CREATE TABLE IF NOT EXISTS jrc_evolution_origin.events (
  id uuid PRIMARY KEY,
  source_sequence bigserial UNIQUE NOT NULL,
  scope_key char(64) NOT NULL,
  event_key char(64) NOT NULL,
  binding_fingerprint char(64) NOT NULL,
  body_hash char(64) NOT NULL,
  payload_ciphertext bytea NOT NULL,
  payload_iv bytea NOT NULL CHECK (octet_length(payload_iv)=12),
  payload_tag bytea NOT NULL CHECK (octet_length(payload_tag)=16),
  key_version integer NOT NULL CHECK (key_version=1),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','CLAIMED','DELIVERED','BLOCKED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  last_category text,
  last_http_status integer CHECK (last_http_status BETWEEN 100 AND 599),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(scope_key,event_key),
  CHECK ((state='CLAIMED')=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS origin_events_pending ON jrc_evolution_origin.events(scope_key,source_sequence) WHERE state<>'DELIVERED';
CREATE TABLE IF NOT EXISTS jrc_evolution_origin.attempts (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES jrc_evolution_origin.events(id),
  number integer NOT NULL CHECK (number>0),
  lease_token uuid NOT NULL UNIQUE,
  outcome text NOT NULL DEFAULT 'CLAIMED' CHECK (outcome IN ('CLAIMED','DELIVERED','RETRY','BLOCKED','LEASE_EXPIRED')),
  category text,
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  duration_ms integer CHECK (duration_ms>=0),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE(event_id,number)
);
-- Low-priority historical obligations use the same source journal/pool, separately
-- from live event ordering. Payloads are sealed before the first database await.
CREATE TABLE IF NOT EXISTS jrc_evolution_origin.history_batches (
  scope_key char(64) NOT NULL CHECK(scope_key ~ '^[a-f0-9]{64}$'),
  capture_id uuid NOT NULL, organization_id uuid NOT NULL, run_id uuid NOT NULL,
  checksum char(64) NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_key,capture_id)
);
CREATE TABLE IF NOT EXISTS jrc_evolution_origin.history_chunks (
  scope_key char(64) NOT NULL, capture_id uuid NOT NULL, run_id uuid NOT NULL, chunk_id uuid NOT NULL,
  source_sequence bigserial UNIQUE NOT NULL, ordinal bigint NOT NULL CHECK(ordinal BETWEEN 0 AND 9007199254740991),
  checksum char(64) NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'),
  payload_hash char(64) NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  payload_bytes integer NOT NULL CHECK(payload_bytes BETWEEN 1 AND 1048576),
  payload_ciphertext bytea NOT NULL CHECK(octet_length(payload_ciphertext)=payload_bytes),
  payload_iv bytea NOT NULL CHECK(octet_length(payload_iv)=12),
  payload_tag bytea NOT NULL CHECK(octet_length(payload_tag)=16),
  state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','DELIVERED')),
  acknowledged_at timestamptz,
  PRIMARY KEY(scope_key,chunk_id), UNIQUE(scope_key,run_id,ordinal),
  FOREIGN KEY(scope_key,capture_id) REFERENCES jrc_evolution_origin.history_batches(scope_key,capture_id),
  CHECK((state='DELIVERED')=(acknowledged_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS origin_history_pending ON jrc_evolution_origin.history_chunks(scope_key,source_sequence) WHERE state='PENDING';
-- Additive source-only schema; never install automatically in a live engine.
-- Descriptors contain the minimal media key/path encrypted with authenticated
-- scope/run/reference AAD. READY means verified Broker custody, not JRC custody.
CREATE TABLE IF NOT EXISTS jrc_evolution_origin.history_media (
  scope_key char(64) NOT NULL,run_id uuid NOT NULL,capture_id uuid NOT NULL,reference_id uuid NOT NULL,
  descriptor_hash char(64) NOT NULL CHECK(descriptor_hash ~ '^[a-f0-9]{64}$'),
  live_message_key char(64) CHECK(live_message_key ~ '^[a-f0-9]{64}$'),
  descriptor_bytes integer NOT NULL CHECK(descriptor_bytes BETWEEN 1 AND 16384),
  descriptor_ciphertext bytea NOT NULL CHECK(octet_length(descriptor_ciphertext)=descriptor_bytes),
  descriptor_iv bytea NOT NULL CHECK(octet_length(descriptor_iv)=12),descriptor_tag bytea NOT NULL CHECK(octet_length(descriptor_tag)=16),
  state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','CLAIMED','READY')),
  lease_token uuid,lease_until timestamptz,attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT '-infinity',persisted_at timestamptz,last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(scope_key,run_id,reference_id),
  FOREIGN KEY(scope_key,capture_id) REFERENCES jrc_evolution_origin.history_batches(scope_key,capture_id),
  CHECK((state='CLAIMED')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK((state='READY')=(persisted_at IS NOT NULL)),
  CHECK(last_error IS NULL OR last_error IN ('DOWNLOAD_FAILED','INTEGRITY_FAILED','PERSISTENCE_UNCERTAIN','AUTHORITY_CHANGED'))
);
CREATE INDEX IF NOT EXISTS origin_history_media_pending ON jrc_evolution_origin.history_media(scope_key,run_id,next_attempt_at) WHERE state<>'READY';
CREATE UNIQUE INDEX origin_live_media_key ON jrc_evolution_origin.history_media(scope_key,run_id,live_message_key) WHERE live_message_key IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION public.history_origin_can_access(key text,org uuid DEFAULT NULL,run uuid DEFAULT NULL) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.history_source_sessions s
  WHERE (s.live_scope_key=key OR s.history_scope_key=key)
   AND (org IS NULL OR s.organization_id=org) AND (run IS NULL OR s.run_id=run)
   AND (session_user='jrc_app' AND s.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    OR s.state='ACTIVE' AND EXISTS(SELECT 1 FROM public.history_origin_engine_roles e
      JOIN public.history_sync_connection_policies p ON p.organization_id=s.organization_id AND p.channel_id=s.channel_id
      WHERE e.role_name=session_user AND e.enabled AND e.engine_id=s.engine_id AND e.generation=s.engine_generation
       AND e.engine_fingerprint=s.engine_fingerprint AND p.enabled AND p.revision=s.policy_revision)))
$$;
REVOKE ALL ON FUNCTION public.history_origin_can_access(text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.history_origin_can_access(text,uuid,uuid) TO jrc_app,jrc_origin;
REVOKE ALL ON SCHEMA jrc_evolution_origin FROM PUBLIC;
GRANT USAGE ON SCHEMA jrc_evolution_origin TO jrc_app,jrc_origin;
REVOKE ALL ON ALL TABLES IN SCHEMA jrc_evolution_origin FROM PUBLIC,jrc_app,jrc_origin;
GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA jrc_evolution_origin TO jrc_app,jrc_origin;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA jrc_evolution_origin TO jrc_app,jrc_origin;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['events','attempts','history_batches','history_chunks','history_media'] LOOP
  EXECUTE format('ALTER TABLE jrc_evolution_origin.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE jrc_evolution_origin.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY origin_migrator ON jrc_evolution_origin.%I TO jrc_migrator USING(true) WITH CHECK(true)',t);
 END LOOP;
END $$;
CREATE POLICY origin_events_scope ON jrc_evolution_origin.events TO jrc_app,jrc_origin
 USING(public.history_origin_can_access(scope_key)) WITH CHECK(public.history_origin_can_access(scope_key));
CREATE POLICY origin_attempts_scope ON jrc_evolution_origin.attempts TO jrc_app,jrc_origin
 USING(EXISTS(SELECT 1 FROM jrc_evolution_origin.events e WHERE e.id=event_id))
 WITH CHECK(EXISTS(SELECT 1 FROM jrc_evolution_origin.events e WHERE e.id=event_id));
CREATE POLICY origin_batches_scope ON jrc_evolution_origin.history_batches TO jrc_app,jrc_origin
 USING(public.history_origin_can_access(scope_key,organization_id,run_id)) WITH CHECK(public.history_origin_can_access(scope_key,organization_id,run_id));
CREATE POLICY origin_chunks_scope ON jrc_evolution_origin.history_chunks TO jrc_app,jrc_origin
 USING(public.history_origin_can_access(scope_key,NULL,run_id)) WITH CHECK(public.history_origin_can_access(scope_key,NULL,run_id));
CREATE POLICY origin_media_scope ON jrc_evolution_origin.history_media TO jrc_app,jrc_origin
 USING(public.history_origin_can_access(scope_key,NULL,run_id)) WITH CHECK(public.history_origin_can_access(scope_key,NULL,run_id));
--> statement-breakpoint
-- Only the separately confirmed existing lifecycle purge may delete retained bytes.
DO $$ DECLARE original text;patched text;BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 patched=replace(original,'DELETE FROM public.history_source_sessions WHERE organization_id=org AND channel_id=channel;',
 'DELETE FROM jrc_evolution_origin.attempts WHERE event_id IN (SELECT e.id FROM jrc_evolution_origin.events e JOIN public.history_source_sessions s ON s.live_scope_key=e.scope_key WHERE s.organization_id=org AND s.channel_id=channel);
  DELETE FROM jrc_evolution_origin.events WHERE scope_key IN (SELECT live_scope_key FROM public.history_source_sessions WHERE organization_id=org AND channel_id=channel);
  DELETE FROM jrc_evolution_origin.history_media WHERE scope_key IN (SELECT history_scope_key FROM public.history_source_sessions WHERE organization_id=org AND channel_id=channel);
  DELETE FROM jrc_evolution_origin.history_chunks WHERE scope_key IN (SELECT history_scope_key FROM public.history_source_sessions WHERE organization_id=org AND channel_id=channel);
  DELETE FROM jrc_evolution_origin.history_batches WHERE scope_key IN (SELECT history_scope_key FROM public.history_source_sessions WHERE organization_id=org AND channel_id=channel);
  DELETE FROM public.history_source_sessions WHERE organization_id=org AND channel_id=channel;');
 IF patched=original THEN RAISE EXCEPTION 'HISTORY_SOURCE_JOURNAL_PURGE_UPGRADE_MISMATCH';END IF;EXECUTE patched;
END $$;
