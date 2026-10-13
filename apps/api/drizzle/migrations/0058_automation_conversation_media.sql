-- New markers only; historical effects and transport behavior remain unchanged.
ALTER TABLE automation_outbox DROP CONSTRAINT automation_outbox_kind_check;
ALTER TABLE automation_outbox ADD CONSTRAINT automation_outbox_kind_check CHECK(kind IN ('SEND_TEXT','SEND_MEDIA','IO_CONVERSATION','HANDOFF','RESUME_EVENT','IO_HTTP','IO_SQL','IO_CODE','IO_AI'));
ALTER TABLE messaging_media DROP CONSTRAINT messaging_media_source_check;
ALTER TABLE messaging_media ADD CONSTRAINT messaging_media_source_check CHECK(source IN ('QR','META','CHATWOOT','UPLOAD'));
ALTER TABLE messaging_media ADD CONSTRAINT messaging_media_upload_identity CHECK(source<>'UPLOAD' OR COALESCE((
 descriptor->>'rootAutomationId' ~ '^[a-f0-9-]{36}$' AND descriptor->>'idempotencyKey' ~ '^[a-f0-9-]{36}$'
 AND descriptor->>'sha256' ~ '^[a-f0-9]{64}$' AND source_key=(descriptor->>'rootAutomationId')||':'||(descriptor->>'idempotencyKey')),false));
CREATE TABLE automation_action_resources (
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),channel_id uuid NOT NULL,
 source text NOT NULL CHECK(source IN ('LOCAL','CENTRAL')),kind text NOT NULL CHECK(kind IN ('LABEL','ATTRIBUTE')),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),key text NOT NULL CHECK(key ~ '^[a-zA-Z_][a-zA-Z0-9_-]{0,99}$'),
 revision text NOT NULL CHECK(revision ~ '^[a-f0-9]{64}$'),edit_revision integer NOT NULL DEFAULT 1 CHECK(edit_revision>0),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','REVOKED')),definition jsonb,remote_id bigint,
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,id),UNIQUE(organization_id,channel_id,id),
 UNIQUE(organization_id,channel_id,source,kind,key),FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id) ON DELETE CASCADE,
 CHECK((kind='LABEL' AND definition IS NULL) OR(kind='ATTRIBUTE' AND definition IS NOT NULL AND jsonb_typeof(definition)='object' AND octet_length(definition::text)<=8192)),
 CHECK(COALESCE((source='LOCAL' AND remote_id IS NULL) OR(source='CENTRAL' AND remote_id>0),false))
);
CREATE TABLE automation_action_catalogs (
 organization_id uuid NOT NULL,channel_id uuid NOT NULL,scope jsonb NOT NULL,credential_revision integer NOT NULL,capabilities jsonb NOT NULL,expires_at timestamptz NOT NULL,
 PRIMARY KEY(organization_id,channel_id),FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id) ON DELETE CASCADE,
 CHECK(octet_length(scope::text)<=4096 AND octet_length(capabilities::text)<=4096)
);
CREATE TABLE automation_conversation_state (
 organization_id uuid NOT NULL,channel_id uuid NOT NULL,conversation_id uuid NOT NULL,
 labels jsonb NOT NULL DEFAULT '[]',attributes jsonb NOT NULL DEFAULT '{}',status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RESOLVED')),
 revision bigint NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,channel_id,conversation_id),
 FOREIGN KEY(organization_id,channel_id,conversation_id) REFERENCES messaging_conversations(organization_id,channel_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id) ON DELETE CASCADE,
 CHECK(jsonb_typeof(labels)='array' AND jsonb_array_length(labels)<=1000 AND jsonb_typeof(attributes)='object' AND octet_length(attributes::text)<=65536)
);
CREATE TABLE automation_private_notes (
 organization_id uuid NOT NULL,id uuid NOT NULL,channel_id uuid NOT NULL,conversation_id uuid NOT NULL,origin_outbox_id uuid NOT NULL,
 body text NOT NULL CHECK(octet_length(body) BETWEEN 1 AND 4096),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,id),
 FOREIGN KEY(organization_id,channel_id,conversation_id) REFERENCES messaging_conversations(organization_id,channel_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id) ON DELETE CASCADE
);
CREATE TABLE automation_conversation_effects (
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),outbox_id uuid NOT NULL,channel_id uuid NOT NULL,conversation_id uuid NOT NULL,
 execution_id uuid NOT NULL,automation_id uuid NOT NULL,version integer NOT NULL,operation text NOT NULL CHECK(operation IN ('tag','attribute','note','resolve','media')),
 profile text NOT NULL CHECK(profile IN ('STANDALONE','CENTRAL')),state text NOT NULL CHECK(state IN ('PREPARED','DISPATCHED','QUEUED','CONFIRMED','REJECTED','UNKNOWN')),
 owner_revision integer NOT NULL,control_revision integer NOT NULL,cycle integer,resource_id uuid,resource_revision text,media_asset_id uuid,media_revision integer,
 dispatch_proof uuid NOT NULL DEFAULT gen_random_uuid(),request_hash text,remote_reference text,messaging_message_id uuid,scope jsonb,credential_revision integer,sender_id bigint,remote_conversation_id bigint,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,id),UNIQUE(organization_id,outbox_id),
 UNIQUE(organization_id,messaging_message_id),FOREIGN KEY(organization_id,outbox_id,execution_id) REFERENCES automation_outbox(organization_id,id,execution_id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,channel_id,conversation_id,execution_id,automation_id,version) REFERENCES automation_executions(organization_id,channel_id,conversation_id,id,automation_id,version) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,channel_id,conversation_id) REFERENCES messaging_conversations(organization_id,channel_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id) ON DELETE CASCADE,
 CHECK(request_hash IS NULL OR request_hash ~ '^[a-f0-9]{64}$')
);
CREATE TABLE automation_media_assets (
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),root_automation_id uuid NOT NULL,channel_id uuid NOT NULL,media_id uuid NOT NULL,
 revision integer NOT NULL DEFAULT 1,status text NOT NULL DEFAULT 'STORING' CHECK(status IN ('STORING','READY','REVOKED')),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),kind text NOT NULL CHECK(kind IN ('image','audio','video','document')),
 idempotency_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id),UNIQUE(organization_id,root_automation_id,channel_id,idempotency_key),
 FOREIGN KEY(organization_id,root_automation_id) REFERENCES automation_definitions(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,channel_id,media_id) REFERENCES messaging_media(organization_id,channel_id,id) ON DELETE CASCADE
);
CREATE TABLE automation_effect_version_pins (
 organization_id uuid NOT NULL,automation_id uuid NOT NULL,version integer NOT NULL,node_id text NOT NULL,
 resource_id uuid,resource_revision text,media_asset_id uuid,media_revision integer,
 PRIMARY KEY(organization_id,automation_id,version,node_id),
 FOREIGN KEY(organization_id,automation_id,version) REFERENCES automation_versions(organization_id,automation_id,version) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,resource_id) REFERENCES automation_action_resources(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,media_asset_id) REFERENCES automation_media_assets(organization_id,id) ON DELETE CASCADE,
 CHECK(COALESCE((resource_id IS NOT NULL AND resource_revision ~ '^[a-f0-9]{64}$' AND media_asset_id IS NULL) OR(media_asset_id IS NOT NULL AND media_revision>0 AND resource_id IS NULL),false))
);
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['automation_action_resources','automation_action_catalogs','automation_conversation_state','automation_private_notes','automation_conversation_effects','automation_media_assets','automation_effect_version_pins'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO jrc_migrator',t);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY automation_effect_tenant ON %I TO jrc_app USING(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',t);
  EXECUTE format('CREATE POLICY lifecycle_migrator ON %I TO jrc_migrator USING(true) WITH CHECK(true)',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth,jrc_platform',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO jrc_app',t);
  INSERT INTO lifecycle_purge_catalogue(table_name) VALUES(t);
 END LOOP;
END $$;
-- Unknown mutation/transport is a permanent automatic resend barrier. Only
-- canonical receipts can move these effects to CONFIRMED, never back to PREPARED.
CREATE FUNCTION automation_conversation_effect_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.organization_id,NEW.id,NEW.outbox_id,NEW.channel_id,NEW.conversation_id,NEW.execution_id,NEW.automation_id,NEW.version,NEW.operation,NEW.profile,NEW.owner_revision,NEW.control_revision,NEW.cycle,NEW.resource_id,NEW.resource_revision,NEW.media_asset_id,NEW.media_revision,NEW.dispatch_proof,NEW.request_hash,NEW.scope,NEW.credential_revision,NEW.sender_id,NEW.remote_conversation_id,NEW.messaging_message_id)
 IS DISTINCT FROM ROW(OLD.organization_id,OLD.id,OLD.outbox_id,OLD.channel_id,OLD.conversation_id,OLD.execution_id,OLD.automation_id,OLD.version,OLD.operation,OLD.profile,OLD.owner_revision,OLD.control_revision,OLD.cycle,OLD.resource_id,OLD.resource_revision,OLD.media_asset_id,OLD.media_revision,OLD.dispatch_proof,OLD.request_hash,OLD.scope,OLD.credential_revision,OLD.sender_id,OLD.remote_conversation_id,OLD.messaging_message_id)
 OR(OLD.state IN ('CONFIRMED','REJECTED') AND NEW.state<>OLD.state)
 OR(OLD.state IN ('DISPATCHED','QUEUED','UNKNOWN') AND NEW.state='PREPARED') THEN
 RAISE EXCEPTION 'AUTOMATION_EFFECT_IDENTITY_IMMUTABLE' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION automation_conversation_effect_immutable() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION automation_conversation_effect_immutable() FROM PUBLIC;
CREATE TRIGGER automation_conversation_effect_immutable BEFORE UPDATE ON automation_conversation_effects FOR EACH ROW EXECUTE FUNCTION automation_conversation_effect_immutable();
