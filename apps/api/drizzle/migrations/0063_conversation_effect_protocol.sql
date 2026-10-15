-- Protocol 2 admissions and authenticated receipts. Historical rows stay v1.
ALTER TABLE automation_conversation_effects
 ADD COLUMN protocol_version integer NOT NULL DEFAULT 1 CHECK(protocol_version IN (1,2)),
 ADD COLUMN remote_context jsonb,
 ADD COLUMN request_body jsonb,
 ADD COLUMN confirmed_receipt jsonb;
ALTER TABLE automation_conversation_effects ADD CONSTRAINT conversation_effect_v2_proof CHECK(
 protocol_version=1 OR COALESCE((
  (profile='STANDALONE' OR operation='media' OR state='REJECTED' AND remote_context IS NULL AND request_body IS NULL OR
   (jsonb_typeof(remote_context)='object' AND jsonb_typeof(request_body)='object'
    AND octet_length(remote_context::text)<=4096 AND octet_length(request_body::text)<=16384))
  AND (confirmed_receipt IS NULL OR jsonb_typeof(confirmed_receipt)='object' AND octet_length(confirmed_receipt::text)<=8192)
  AND (state<>'CONFIRMED' OR profile='STANDALONE' OR operation='media' OR confirmed_receipt IS NOT NULL)
  AND (operation='media' OR messaging_message_id IS NULL)
  AND outbox_id IS NOT NULL
 ),false));
CREATE UNIQUE INDEX conversation_effect_one_open ON automation_conversation_effects(organization_id,conversation_id)
 WHERE protocol_version=2 AND state IN ('PREPARED','DISPATCHED','QUEUED','UNKNOWN');
ALTER TABLE automation_conversation_effects ADD CONSTRAINT conversation_effect_control_scope UNIQUE(organization_id,outbox_id,conversation_id);
CREATE INDEX automation_private_notes_conversation_recent
 ON automation_private_notes(organization_id,channel_id,conversation_id,created_at DESC,id DESC);
CREATE TABLE automation_effect_control_steps (
 organization_id uuid NOT NULL,outbox_id uuid NOT NULL,conversation_id uuid NOT NULL,
 before_revision integer NOT NULL CHECK(before_revision>=0),after_revision integer NOT NULL,
 observation_id uuid NOT NULL,phase text NOT NULL CHECK(phase IN ('PENDING','CONFIRMED')),
 PRIMARY KEY(organization_id,conversation_id,after_revision),
 UNIQUE(organization_id,outbox_id,observation_id,phase),
 FOREIGN KEY(organization_id,outbox_id,conversation_id) REFERENCES automation_conversation_effects(organization_id,outbox_id,conversation_id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,conversation_id) REFERENCES messaging_conversations(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,observation_id) REFERENCES chatwoot_attendance_observations(organization_id,id) ON DELETE CASCADE,
 CHECK(after_revision=before_revision+1)
);
ALTER TABLE automation_effect_control_steps OWNER TO jrc_migrator;
ALTER TABLE automation_effect_control_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_effect_control_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY effect_control_tenant ON automation_effect_control_steps TO jrc_app
 USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY lifecycle_migrator ON automation_effect_control_steps TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON automation_effect_control_steps FROM PUBLIC,jrc_auth,jrc_platform;
GRANT SELECT,INSERT ON automation_effect_control_steps TO jrc_app;
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('automation_effect_control_steps');
ALTER TABLE chatwoot_attendance_observations ADD COLUMN effect_outbox_id uuid;
ALTER TABLE chatwoot_attendance_observations ADD CONSTRAINT attendance_effect_scope
 FOREIGN KEY(organization_id,effect_outbox_id) REFERENCES automation_conversation_effects(organization_id,outbox_id) ON DELETE SET NULL (effect_outbox_id);
CREATE INDEX attendance_effect_pending ON chatwoot_attendance_observations(organization_id,effect_outbox_id)
 WHERE effect_outbox_id IS NOT NULL AND disposition='ECHO_PENDING';
CREATE FUNCTION conversation_effect_v2_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.protocol_version,NEW.remote_context,NEW.request_body)
 IS DISTINCT FROM ROW(OLD.protocol_version,OLD.remote_context,OLD.request_body)
 OR (OLD.confirmed_receipt IS NOT NULL AND NEW.confirmed_receipt IS DISTINCT FROM OLD.confirmed_receipt)
 OR (OLD.state='CONFIRMED' AND NEW.remote_reference IS DISTINCT FROM OLD.remote_reference)
 THEN RAISE EXCEPTION 'AUTOMATION_EFFECT_PROOF_IMMUTABLE' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION conversation_effect_v2_immutable() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION conversation_effect_v2_immutable() FROM PUBLIC;
CREATE TRIGGER conversation_effect_v2_immutable BEFORE UPDATE ON automation_conversation_effects
 FOR EACH ROW EXECUTE FUNCTION conversation_effect_v2_immutable();
