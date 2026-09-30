-- Attendance is channel-scoped. A remote scope exists only for a real integration.
ALTER TABLE chatwoot_connections ADD CONSTRAINT attendance_connection_channel_unique UNIQUE(organization_id,channel_id,id);
ALTER TABLE automation_executions ADD CONSTRAINT attendance_execution_conversation_unique UNIQUE(organization_id,channel_id,conversation_id,id,automation_id,version);
CREATE TABLE attendance_owners (
 organization_id uuid NOT NULL, channel_id uuid NOT NULL, integration_id uuid,
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 executor text NOT NULL DEFAULT 'NONE' CHECK(executor IN ('BROKER','EXTERNAL','NONE')),
 automation_id uuid, version integer CHECK(version>0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,channel_id),
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id),
 FOREIGN KEY(organization_id,channel_id,integration_id) REFERENCES chatwoot_connections(organization_id,channel_id,id),
 FOREIGN KEY(organization_id,automation_id,version) REFERENCES automation_versions(organization_id,automation_id,version),
 CHECK((automation_id IS NULL)=(version IS NULL)),
 CHECK(executor='BROKER' OR automation_id IS NULL)
);
CREATE TABLE attendance_sessions (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
 channel_id uuid NOT NULL, conversation_id uuid NOT NULL,
 integration_id uuid, destination_revision integer CHECK(destination_revision>0),
 account_id bigint CHECK(account_id BETWEEN 1 AND 9007199254740991), inbox_id bigint CHECK(inbox_id BETWEEN 1 AND 9007199254740991),
 cycle integer NOT NULL CHECK(cycle>0), execution_id uuid, automation_id uuid, version integer CHECK(version>0),
 state text NOT NULL CHECK(state IN ('BOT_ACTIVE','WAITING_INPUT','HANDOFF_PENDING','WAITING_HUMAN','HUMAN_ACTIVE','RESOLVED','ADMIN_PAUSED')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), owner_revision integer NOT NULL CHECK(owner_revision>=0),
 remote_conversation_id bigint CHECK(remote_conversation_id BETWEEN 1 AND 9007199254740991),
 resume_node_id text CHECK(length(resume_node_id) BETWEEN 1 AND 100),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,conversation_id,cycle),
 CONSTRAINT attendance_session_conversation_fk FOREIGN KEY(organization_id,channel_id,conversation_id) REFERENCES messaging_conversations(organization_id,channel_id,id),
 FOREIGN KEY(organization_id,channel_id,integration_id) REFERENCES chatwoot_connections(organization_id,channel_id,id),
 CONSTRAINT attendance_session_execution_version_fk
  FOREIGN KEY(organization_id,channel_id,conversation_id,execution_id,automation_id,version)
  REFERENCES automation_executions(organization_id,channel_id,conversation_id,id,automation_id,version),
 FOREIGN KEY(organization_id,automation_id,version) REFERENCES automation_versions(organization_id,automation_id,version),
 CHECK((automation_id IS NULL)=(version IS NULL)),
 CONSTRAINT attendance_session_execution_requires_version CHECK(execution_id IS NULL OR (automation_id IS NOT NULL AND version IS NOT NULL)),
 CHECK((integration_id IS NULL AND destination_revision IS NULL AND account_id IS NULL AND inbox_id IS NULL AND remote_conversation_id IS NULL)
    OR (integration_id IS NOT NULL AND destination_revision IS NOT NULL AND account_id IS NOT NULL AND inbox_id IS NOT NULL))
);
CREATE UNIQUE INDEX attendance_one_live_conversation ON attendance_sessions(organization_id,conversation_id) WHERE state<>'RESOLVED';
CREATE INDEX attendance_channel_sessions ON attendance_sessions(organization_id,channel_id);
-- Existing bindings and execution/session rows are preserved verbatim. This is a
-- snapshot of current ownership, not a conversion of legacy runtime state.
INSERT INTO attendance_owners(organization_id,channel_id,integration_id,revision,executor,automation_id,version)
 SELECT c.organization_id,c.id,cw.id,coalesce(b.revision,1),
  CASE WHEN c.bot_public_id IS NULL THEN 'NONE'
       WHEN c.bot_origin_reference IN ('jrc-automation-v2','jrc-flows-native') THEN 'BROKER' ELSE 'EXTERNAL' END,
  b.automation_id,b.version
 FROM messaging_channels c
 LEFT JOIN chatwoot_connections cw ON cw.organization_id=c.organization_id AND cw.channel_id=c.id
 LEFT JOIN automation_bindings b ON b.organization_id=c.organization_id AND b.channel_id=c.id
   AND b.status IN ('ACTIVE','PAUSED') AND c.bot_origin_reference='jrc-automation-v2' AND b.automation_id::text=c.bot_public_id;
--> statement-breakpoint
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['attendance_owners','attendance_sessions'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO jrc_migrator',tab);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY attendance_tenant ON %I TO jrc_app USING(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',tab);
  EXECUTE format('CREATE POLICY lifecycle_migrator ON %I TO jrc_migrator USING(true) WITH CHECK(true)',tab);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth,jrc_platform',tab);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO jrc_app',tab);
 END LOOP;
END $$;
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('attendance_sessions'),('attendance_owners');
-- The existing organization purge derives FK order from the catalogue. The
-- channel purge uses an explicit order; extend its body without copying and
-- accidentally relaxing any of its authorization/pending-work checks.
DO $$ DECLARE original text; patched text; BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 patched=replace(original,'-- Remove the complete channel-owned execution tree before the binding or message it references.',
  'DELETE FROM public.attendance_sessions WHERE organization_id=org AND channel_id=channel;
   DELETE FROM public.attendance_owners WHERE organization_id=org AND channel_id=channel;
   -- Remove the complete channel-owned execution tree before the binding or message it references.');
 IF patched=original THEN RAISE EXCEPTION 'ATTENDANCE_CHANNEL_PURGE_UPGRADE_MISMATCH'; END IF;
 EXECUTE patched;
END $$;
