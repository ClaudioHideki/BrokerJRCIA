-- The pre-existing PK on qr_dispatch_attempts satisfies the FK. All new
-- indexes are built on the empty child. No rewrite or backfill of old attempts.
LOCK TABLE qr_dispatch_attempts IN SHARE ROW EXCLUSIVE MODE NOWAIT;
CREATE TABLE qr_dispatch_evidence (
  organization_id uuid NOT NULL, attempt_id uuid NOT NULL, engine_scope text NOT NULL CHECK(engine_scope ~ '^[0-9a-f]{64}$'),
  physical_dispatch jsonb NOT NULL CHECK(jsonb_typeof(physical_dispatch)='object'),
  physical_response_key text CHECK(length(btrim(physical_response_key)) BETWEEN 1 AND 256),
  conflicting_response_key text CHECK(length(btrim(conflicting_response_key)) BETWEEN 1 AND 256),
  key_conflict boolean NOT NULL DEFAULT false,
  PRIMARY KEY(organization_id,attempt_id),
  CONSTRAINT qr_dispatch_evidence_key UNIQUE(organization_id,engine_scope,physical_response_key),
  CHECK(conflicting_response_key IS NULL OR key_conflict),
  FOREIGN KEY(organization_id,attempt_id) REFERENCES qr_dispatch_attempts(organization_id,id) ON DELETE CASCADE
);
ALTER TABLE qr_dispatch_evidence OWNER TO jrc_migrator;
ALTER TABLE qr_dispatch_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE qr_dispatch_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY qr_evidence_tenant ON qr_dispatch_evidence TO jrc_app
 USING(organization_id=nullif(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK(organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY lifecycle_migrator ON qr_dispatch_evidence TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON qr_dispatch_evidence FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
GRANT SELECT,INSERT(organization_id,attempt_id,engine_scope,physical_dispatch),
  UPDATE(physical_response_key,key_conflict,conflicting_response_key) ON qr_dispatch_evidence TO jrc_app;
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('qr_dispatch_evidence');
CREATE FUNCTION qr_keep_dispatch_trace() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.physical_dispatch IS DISTINCT FROM NEW.physical_dispatch OR OLD.engine_scope IS DISTINCT FROM NEW.engine_scope OR
     OLD.organization_id IS DISTINCT FROM NEW.organization_id OR OLD.attempt_id IS DISTINCT FROM NEW.attempt_id OR
     OLD.key_conflict AND NOT NEW.key_conflict OR
     OLD.physical_response_key IS NOT NULL AND NEW.physical_response_key IS DISTINCT FROM OLD.physical_response_key OR
     OLD.conflicting_response_key IS NOT NULL AND NEW.conflicting_response_key IS DISTINCT FROM OLD.conflicting_response_key THEN
    RAISE EXCEPTION 'QR_DISPATCH_TRACE_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER qr_keep_dispatch_trace BEFORE UPDATE ON qr_dispatch_evidence
  FOR EACH ROW EXECUTE FUNCTION qr_keep_dispatch_trace();
CREATE VIEW qr_traced_dispatch_attempts WITH (security_invoker=true) AS
 SELECT a.id,a.organization_id,a.channel_id,a.conversation_id,a.message_id,a.lease_token,
        a.state,a.provider_message_id,a.created_at,e.physical_dispatch,e.physical_response_key,e.key_conflict
 FROM qr_dispatch_attempts a
 LEFT JOIN qr_dispatch_evidence e ON e.organization_id=a.organization_id AND e.attempt_id=a.id;
GRANT SELECT ON qr_traced_dispatch_attempts TO jrc_app;
