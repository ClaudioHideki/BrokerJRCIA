-- Canonical central input references only: no blob, URL, media asset or download job.
ALTER TABLE central_runtime_events DROP CONSTRAINT central_runtime_events_kind_check;
ALTER TABLE central_runtime_events ADD CONSTRAINT central_runtime_events_kind_check
 CHECK(kind IN ('CONTACT_TEXT','CONTACT_MEDIA','ATTENDANCE_OBSERVATION','BROKER_ECHO'));
ALTER TABLE central_runtime_events ADD COLUMN media_input jsonb;
ALTER TABLE central_runtime_events ADD CONSTRAINT central_runtime_events_media_input_check CHECK(
 (kind='CONTACT_MEDIA' AND media_input IS NOT NULL AND jsonb_typeof(media_input)='object'
  AND media_input ?& ARRAY['version','contactId','attachments']
  AND media_input - ARRAY['version','contactId','attachments']='{}'::jsonb
  AND media_input @> '{"version":1}'::jsonb AND jsonb_typeof(media_input->'contactId')='number'
  AND jsonb_typeof(media_input->'attachments')='array'
  AND jsonb_array_length(media_input->'attachments') BETWEEN 1 AND 10)
 OR(kind<>'CONTACT_MEDIA' AND media_input IS NULL));
ALTER TABLE central_runtime_events ADD CONSTRAINT central_runtime_media_scope_unique
 UNIQUE(organization_id,channel_id,integration_id,conversation_id,id,remote_conversation_id,remote_message_id);
--> statement-breakpoint
CREATE TABLE central_flow_input_media (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), channel_id uuid NOT NULL,
 integration_id uuid NOT NULL, conversation_id uuid NOT NULL, event_id uuid NOT NULL,
 origin text NOT NULL CHECK(length(origin) BETWEEN 1 AND 2048), account_id bigint NOT NULL CHECK(account_id BETWEEN 1 AND 9007199254740991),
 inbox_id bigint NOT NULL CHECK(inbox_id BETWEEN 1 AND 9007199254740991), contact_id bigint NOT NULL CHECK(contact_id BETWEEN 1 AND 9007199254740991),
 remote_conversation_id bigint NOT NULL CHECK(remote_conversation_id BETWEEN 1 AND 9007199254740991),
 remote_message_id bigint NOT NULL CHECK(remote_message_id BETWEEN 1 AND 9007199254740991),
 attachment_id bigint NOT NULL CHECK(attachment_id BETWEEN 1 AND 9007199254740991),
 destination_revision integer NOT NULL CHECK(destination_revision>0), credential_version integer NOT NULL CHECK(credential_version>0),
 owner_revision integer NOT NULL CHECK(owner_revision>=0), kind text NOT NULL CHECK(kind IN ('image','document')),
 file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 255), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,event_id,attachment_id),
 UNIQUE(organization_id,integration_id,remote_conversation_id,remote_message_id,attachment_id),
 CONSTRAINT central_flow_media_event_fk FOREIGN KEY(organization_id,channel_id,integration_id,conversation_id,event_id,remote_conversation_id,remote_message_id)
  REFERENCES central_runtime_events(organization_id,channel_id,integration_id,conversation_id,id,remote_conversation_id,remote_message_id) ON DELETE CASCADE,
 CONSTRAINT central_flow_media_conversation_fk FOREIGN KEY(organization_id,channel_id,conversation_id) REFERENCES messaging_conversations(organization_id,channel_id,id) ON DELETE CASCADE,
 CONSTRAINT central_flow_media_connection_fk FOREIGN KEY(organization_id,channel_id,integration_id) REFERENCES chatwoot_connections(organization_id,channel_id,id) ON DELETE CASCADE
);
CREATE INDEX central_flow_input_media_scope ON central_flow_input_media(organization_id,channel_id,conversation_id,id);
ALTER TABLE central_flow_input_media OWNER TO jrc_migrator;
ALTER TABLE central_flow_input_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE central_flow_input_media FORCE ROW LEVEL SECURITY;
CREATE POLICY central_tenant ON central_flow_input_media TO jrc_app
 USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY lifecycle_migrator ON central_flow_input_media TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON central_flow_input_media FROM PUBLIC,jrc_auth,jrc_platform,jrc_app;
GRANT SELECT,INSERT ON central_flow_input_media TO jrc_app;
--> statement-breakpoint
CREATE FUNCTION reject_central_flow_input_media_update() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'CENTRAL_MEDIA_REFERENCE_IMMUTABLE'; END $$;
ALTER FUNCTION reject_central_flow_input_media_update() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION reject_central_flow_input_media_update() FROM PUBLIC;
CREATE TRIGGER central_flow_input_media_immutable BEFORE UPDATE ON central_flow_input_media
 FOR EACH ROW EXECUTE FUNCTION reject_central_flow_input_media_update();
--> statement-breakpoint
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('central_flow_input_media');
