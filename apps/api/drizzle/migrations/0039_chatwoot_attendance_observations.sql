-- Authenticated control is durable even when the asynchronous mirror has not returned a remote ID.
CREATE TABLE chatwoot_attendance_controls (
 organization_id uuid NOT NULL, channel_id uuid NOT NULL, conversation_id uuid NOT NULL,
 integration_id uuid NOT NULL, destination_revision integer NOT NULL CHECK(destination_revision>0),
 account_id bigint NOT NULL CHECK(account_id BETWEEN 1 AND 9007199254740991),
 inbox_id bigint NOT NULL CHECK(inbox_id BETWEEN 1 AND 9007199254740991),
 remote_conversation_id bigint CHECK(remote_conversation_id BETWEEN 1 AND 9007199254740991),
 cycle integer NOT NULL CHECK(cycle>0), revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 state text NOT NULL CHECK(state IN ('INITIALIZING','READY','HUMAN','PAUSED','RECONCILE')),
 observed_remote_updated_at double precision, last_observation_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,conversation_id),
 FOREIGN KEY(organization_id,channel_id,conversation_id) REFERENCES messaging_conversations(organization_id,channel_id,id),
 FOREIGN KEY(organization_id,channel_id,integration_id) REFERENCES chatwoot_connections(organization_id,channel_id,id)
);
CREATE UNIQUE INDEX chatwoot_attendance_remote_scope ON chatwoot_attendance_controls
 (organization_id,integration_id,destination_revision,account_id,inbox_id,remote_conversation_id) WHERE remote_conversation_id IS NOT NULL;
CREATE TABLE chatwoot_mirror_attempts (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), channel_id uuid NOT NULL,
 integration_id uuid NOT NULL, destination_revision integer NOT NULL CHECK(destination_revision>0),
 account_id bigint NOT NULL CHECK(account_id BETWEEN 1 AND 9007199254740991),
 inbox_id bigint NOT NULL CHECK(inbox_id BETWEEN 1 AND 9007199254740991),
 conversation_id uuid NOT NULL, remote_conversation_id bigint NOT NULL CHECK(remote_conversation_id BETWEEN 1 AND 9007199254740991),
 cycle integer NOT NULL CHECK(cycle>0), message_id uuid NOT NULL, job_id uuid NOT NULL, lease_token uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('DISPATCHED','CONFIRMED','UNKNOWN','REJECTED')),
 remote_message_id bigint CHECK(remote_message_id BETWEEN 1 AND 9007199254740991),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,job_id,lease_token),
 FOREIGN KEY(organization_id,channel_id,conversation_id) REFERENCES messaging_conversations(organization_id,channel_id,id),
 FOREIGN KEY(organization_id,channel_id,integration_id) REFERENCES chatwoot_connections(organization_id,channel_id,id),
 FOREIGN KEY(organization_id,message_id) REFERENCES messaging_messages(organization_id,id),
 FOREIGN KEY(organization_id,job_id) REFERENCES integration_jobs(organization_id,id),
 CHECK((state='CONFIRMED')=(remote_message_id IS NOT NULL))
);
CREATE INDEX chatwoot_mirror_echo_lookup ON chatwoot_mirror_attempts(organization_id,integration_id,destination_revision,remote_conversation_id,message_id);
CREATE TABLE chatwoot_attendance_observations (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), integration_id uuid NOT NULL, channel_id uuid NOT NULL,
 destination_revision integer NOT NULL CHECK(destination_revision>0), credential_revision integer NOT NULL CHECK(credential_revision>0),
 account_id bigint NOT NULL CHECK(account_id BETWEEN 1 AND 9007199254740991), inbox_id bigint NOT NULL CHECK(inbox_id BETWEEN 1 AND 9007199254740991),
 remote_conversation_id bigint NOT NULL CHECK(remote_conversation_id BETWEEN 1 AND 9007199254740991),
 conversation_id uuid, cycle integer CHECK(cycle>0), event_key text NOT NULL CHECK(length(event_key) BETWEEN 1 AND 180),
 event jsonb NOT NULL CHECK(jsonb_typeof(event)='object'),
 disposition text NOT NULL CHECK(disposition IN ('WAITING_MAP','ECHO_PENDING','APPLIED','IGNORED','RECONCILE')),
 mirror_attempt_id uuid, reply_payload jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), applied_at timestamptz,
 PRIMARY KEY(organization_id,id),
 UNIQUE(organization_id,integration_id,destination_revision,account_id,inbox_id,event_key),
 FOREIGN KEY(organization_id,channel_id,integration_id) REFERENCES chatwoot_connections(organization_id,channel_id,id),
 FOREIGN KEY(organization_id,channel_id,conversation_id) REFERENCES messaging_conversations(organization_id,channel_id,id),
 FOREIGN KEY(organization_id,mirror_attempt_id) REFERENCES chatwoot_mirror_attempts(organization_id,id),
 CHECK(reply_payload IS NULL OR (event->>'mayForwardReply'='true' AND event->>'kind' IN ('HUMAN_PUBLIC','EXTERNAL_BOT','AUTOMATED_REPLY')))
);
CREATE INDEX chatwoot_attendance_pending ON chatwoot_attendance_observations
 (organization_id,integration_id,destination_revision,remote_conversation_id,created_at,id) WHERE disposition IN ('WAITING_MAP','ECHO_PENDING','RECONCILE');
--> statement-breakpoint
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['chatwoot_attendance_controls','chatwoot_mirror_attempts','chatwoot_attendance_observations'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO jrc_migrator',tab);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY attendance_tenant ON %I TO jrc_app USING(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',tab);
  EXECUTE format('CREATE POLICY lifecycle_migrator ON %I TO jrc_migrator USING(true) WITH CHECK(true)',tab);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth,jrc_platform',tab);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO jrc_app',tab);
 END LOOP;
END $$;
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('chatwoot_attendance_controls'),('chatwoot_mirror_attempts'),('chatwoot_attendance_observations');
-- Preserve the audited lifecycle authorization and pending-work checks in the existing function.
DO $$ DECLARE original text; patched text; BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 patched=replace(original,'DELETE FROM public.attendance_sessions WHERE organization_id=org AND channel_id=channel;',
  'DELETE FROM public.chatwoot_attendance_observations WHERE organization_id=org AND channel_id=channel;
   DELETE FROM public.chatwoot_mirror_attempts WHERE organization_id=org AND channel_id=channel;
   DELETE FROM public.chatwoot_attendance_controls WHERE organization_id=org AND channel_id=channel;
   DELETE FROM public.attendance_sessions WHERE organization_id=org AND channel_id=channel;');
 IF patched=original THEN RAISE EXCEPTION 'ATTENDANCE_OBSERVATIONS_PURGE_UPGRADE_MISMATCH'; END IF;
 EXECUTE patched;
END $$;
