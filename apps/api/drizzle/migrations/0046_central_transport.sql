-- Physical channels keep their transport. A central inbox has no fake provider identity.
ALTER TABLE messaging_channels
 ADD COLUMN transport text NOT NULL DEFAULT 'BROKER_TRANSPORT',
 ALTER COLUMN provider DROP NOT NULL,
 ALTER COLUMN provider_account_id DROP NOT NULL,
 ALTER COLUMN credential_reference DROP NOT NULL,
 ADD CONSTRAINT messaging_channels_organization_fk FOREIGN KEY(organization_id) REFERENCES organizations(id),
 DROP CONSTRAINT messaging_channels_kind_fields,
 ADD CONSTRAINT messaging_channels_kind_fields CHECK (
  (transport='BROKER_TRANSPORT' AND provider IS NOT NULL AND provider_account_id IS NOT NULL
   AND credential_reference IS NOT NULL AND btrim(credential_reference)<>''
   AND ((provider='META' AND instance_id IS NULL AND phone_number_id IS NOT NULL AND waba_id IS NOT NULL)
     OR (provider='BAILEYS' AND instance_id IS NOT NULL AND phone_number_id IS NULL AND waba_id IS NULL)))
  OR (transport='CENTRAL_TRANSPORT' AND provider IS NULL AND provider_account_id IS NULL AND instance_id IS NULL
    AND phone_number_id IS NULL AND waba_id IS NULL AND credential_reference IS NULL)
 ),
 ADD CONSTRAINT messaging_channels_transport_identity UNIQUE(organization_id,id,transport);
--> statement-breakpoint
-- A central may create a new conversation with the same contact. Preserve the physical uniqueness rule.
ALTER TABLE messaging_conversations ADD COLUMN remote_conversation_key text,
 DROP CONSTRAINT messaging_conversations_participants_unique;
CREATE UNIQUE INDEX messaging_conversations_participants_unique ON messaging_conversations(organization_id,channel_id,contact_id)
 WHERE remote_conversation_key IS NULL;
CREATE UNIQUE INDEX messaging_conversations_remote_unique ON messaging_conversations(organization_id,channel_id,remote_conversation_key)
 WHERE remote_conversation_key IS NOT NULL;
CREATE TABLE central_transport_bindings (
 organization_id uuid NOT NULL, channel_id uuid NOT NULL, integration_id uuid NOT NULL,
 transport text NOT NULL DEFAULT 'CENTRAL_TRANSPORT' CHECK(transport='CENTRAL_TRANSPORT'),
 origin text NOT NULL CHECK(length(origin)<=2048 AND origin ~ '^https://[^/?#@]+$'),
 account_id bigint NOT NULL CHECK(account_id BETWEEN 1 AND 9007199254740991),
 inbox_id bigint NOT NULL CHECK(inbox_id BETWEEN 1 AND 9007199254740991),
 destination_revision integer NOT NULL CHECK(destination_revision>0),
 credential_version integer NOT NULL CHECK(credential_version>0),
 owner_revision integer NOT NULL CHECK(owner_revision>=0),
 status text NOT NULL DEFAULT 'READY' CHECK(status IN ('READY','DISABLED','PENDING','FAILED','UNKNOWN')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,channel_id), UNIQUE(origin,account_id,inbox_id), UNIQUE(organization_id,integration_id),
 FOREIGN KEY(organization_id,channel_id,transport) REFERENCES messaging_channels(organization_id,id,transport),
 FOREIGN KEY(organization_id,channel_id,integration_id) REFERENCES chatwoot_connections(organization_id,channel_id,id),
 FOREIGN KEY(organization_id,origin) REFERENCES chatwoot_destinations(organization_id,base_url)
);
CREATE TABLE central_runtime_events (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), channel_id uuid NOT NULL,
 integration_id uuid NOT NULL, event_key text NOT NULL CHECK(length(event_key) BETWEEN 1 AND 128),
 kind text NOT NULL CHECK(kind IN ('CONTACT_TEXT','ATTENDANCE_OBSERVATION','BROKER_ECHO')),
 destination_revision integer NOT NULL CHECK(destination_revision>0), credential_version integer NOT NULL CHECK(credential_version>0),
 owner_revision integer NOT NULL CHECK(owner_revision>=0), remote_conversation_id bigint NOT NULL CHECK(remote_conversation_id BETWEEN 1 AND 9007199254740991),
 remote_message_id bigint CHECK(remote_message_id BETWEEN 1 AND 9007199254740991),
 conversation_id uuid, message_id uuid,
 disposition text NOT NULL DEFAULT 'RECEIVED' CHECK(disposition IN ('RECEIVED','OBSERVED','ROUTED','IGNORED')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,channel_id,event_key),
 FOREIGN KEY(organization_id,channel_id) REFERENCES central_transport_bindings(organization_id,channel_id),
 FOREIGN KEY(organization_id,channel_id,integration_id) REFERENCES chatwoot_connections(organization_id,channel_id,id),
 FOREIGN KEY(organization_id,channel_id,conversation_id) REFERENCES messaging_conversations(organization_id,channel_id,id),
 FOREIGN KEY(organization_id,message_id) REFERENCES messaging_messages(organization_id,id)
);
CREATE INDEX central_runtime_events_pending ON central_runtime_events(organization_id,channel_id,created_at,id) WHERE disposition='RECEIVED';
--> statement-breakpoint
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['central_transport_bindings','central_runtime_events'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO jrc_migrator',tab);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY central_tenant ON %I TO jrc_app USING(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',tab);
  EXECUTE format('CREATE POLICY lifecycle_migrator ON %I TO jrc_migrator USING(true) WITH CHECK(true)',tab);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth,jrc_platform',tab);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO jrc_app',tab);
 END LOOP;
END $$;
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('central_runtime_events'),('central_transport_bindings');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enqueue_chatwoot_mirror() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.state=OLD.state THEN RETURN NEW; END IF;
 INSERT INTO public.integration_jobs(organization_id,integration_id,kind,dedupe_key,message_id)
 SELECT NEW.organization_id,c.id,'MIRROR_MESSAGE','message:'||NEW.id::text||':'||NEW.state::text,NEW.id
 FROM public.chatwoot_connections c JOIN public.messaging_channels m ON m.organization_id=c.organization_id AND m.id=c.channel_id
 WHERE c.organization_id=NEW.organization_id AND c.channel_id=NEW.channel_id AND c.status IN ('READY','DISABLED')
   AND m.transport='BROKER_TRANSPORT'
 ON CONFLICT(organization_id,integration_id,dedupe_key) DO NOTHING;
 RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ DECLARE original text; patched text; BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 patched=replace(original,'DELETE FROM public.attendance_resume_operations WHERE organization_id=org AND channel_id=channel;',
 'DELETE FROM public.central_runtime_events WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.central_transport_bindings WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.attendance_resume_operations WHERE organization_id=org AND channel_id=channel;');
 IF patched=original THEN RAISE EXCEPTION 'CENTRAL_PURGE_PATCH_TARGET_MISSING'; END IF;
 EXECUTE patched;
END $$;
