-- G2: authenticated group events and durable webhook configuration per QR channel.
ALTER TABLE whatsapp_group_catalogs DROP CONSTRAINT whatsapp_group_catalogs_last_error_code_check;
ALTER TABLE whatsapp_group_catalogs ADD CONSTRAINT whatsapp_group_catalogs_last_error_code_check CHECK(last_error_code IN (
 'PROVIDER_ABORTED','PROVIDER_TIMEOUT','PROVIDER_REQUEST_FAILED','PROVIDER_INVALID_RESPONSE','IDENTITY_CHANGED','LEASE_LOST',
 'GROUP_MEMBERSHIP_CHANGED','GROUP_METADATA_CHANGED'
));
CREATE TABLE whatsapp_group_events (
 organization_id uuid NOT NULL,channel_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),
 identity_revision bigint NOT NULL CHECK(identity_revision>0),identity_fingerprint text NOT NULL CHECK(identity_fingerprint ~ '^[a-f0-9]{64}$'),
 event_key text NOT NULL CHECK(event_key ~ '^[a-f0-9]{64}$'),group_jid text NOT NULL CHECK(length(group_jid)<=128 AND group_jid ~ '^[0-9]+(-[0-9]+)?@g[.]us$'),
 event_kind text NOT NULL CHECK(event_kind IN ('UPSERT','UPDATE','ADD','REMOVE','PROMOTE','DEMOTE')),
 provider_emitted_at text NOT NULL CHECK(length(provider_emitted_at) BETWEEN 20 AND 40),
 author_jid text CHECK(author_jid IS NULL OR (length(author_jid)<=128 AND author_jid ~ '^([1-9][0-9]{6,14}@s[.]whatsapp[.]net|[0-9]+@lid)$')),
 participants jsonb NOT NULL CHECK(jsonb_typeof(participants)='array' AND jsonb_array_length(participants)<=2000),
 metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=2048),
 own_number_effect text NOT NULL CHECK(own_number_effect IN ('UNVERIFIED','ADD_OBSERVED','REMOVAL_OBSERVED')),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,id),UNIQUE(organization_id,channel_id,id),
 UNIQUE(organization_id,channel_id,identity_revision,event_key),
 UNIQUE(organization_id,channel_id,identity_revision,identity_fingerprint,group_jid,id),
 FOREIGN KEY(organization_id,channel_id) REFERENCES whatsapp_group_catalogs(organization_id,channel_id)
);
CREATE INDEX whatsapp_group_events_channel_received ON whatsapp_group_events(organization_id,channel_id,received_at,id);
CREATE TABLE whatsapp_group_participation (
 organization_id uuid NOT NULL,channel_id uuid NOT NULL,identity_revision bigint NOT NULL CHECK(identity_revision>0),
 identity_fingerprint text NOT NULL CHECK(identity_fingerprint ~ '^[a-f0-9]{64}$'),
 group_jid text NOT NULL CHECK(length(group_jid)<=128 AND group_jid ~ '^[0-9]+(-[0-9]+)?@g[.]us$'),
 own_state text NOT NULL CHECK(own_state IN ('PRESENT_FROM_CATALOG','REMOVAL_OBSERVED','UNVERIFIED')),
 source_snapshot_id uuid,last_event_id uuid,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,channel_id,identity_revision,group_jid),
 FOREIGN KEY(organization_id,channel_id) REFERENCES whatsapp_group_catalogs(organization_id,channel_id),
 FOREIGN KEY(organization_id,channel_id,identity_revision,identity_fingerprint,group_jid,last_event_id)
  REFERENCES whatsapp_group_events(organization_id,channel_id,identity_revision,identity_fingerprint,group_jid,id),
 CONSTRAINT whatsapp_group_participation_evidence CHECK((own_state='PRESENT_FROM_CATALOG' AND source_snapshot_id IS NOT NULL AND last_event_id IS NULL)
  OR (own_state<>'PRESENT_FROM_CATALOG' AND source_snapshot_id IS NULL AND last_event_id IS NOT NULL))
);
CREATE TABLE whatsapp_group_participants (
 organization_id uuid NOT NULL,channel_id uuid NOT NULL,identity_revision bigint NOT NULL CHECK(identity_revision>0),
 identity_fingerprint text NOT NULL CHECK(identity_fingerprint ~ '^[a-f0-9]{64}$'),
 group_jid text NOT NULL CHECK(length(group_jid)<=128 AND group_jid ~ '^[0-9]+(-[0-9]+)?@g[.]us$'),
 participant_jid text NOT NULL CHECK(length(participant_jid)<=128 AND participant_jid ~ '^([1-9][0-9]{6,14}@s[.]whatsapp[.]net|[0-9]+@lid)$'),
 last_action text NOT NULL CHECK(last_action IN ('UPSERT','ADD','REMOVE','PROMOTE','DEMOTE')),
 last_event_id uuid NOT NULL,observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,channel_id,identity_revision,group_jid,participant_jid),
 FOREIGN KEY(organization_id,channel_id,identity_revision,identity_fingerprint,group_jid,last_event_id)
  REFERENCES whatsapp_group_events(organization_id,channel_id,identity_revision,identity_fingerprint,group_jid,id)
);
CREATE TABLE whatsapp_group_webhook_operations (
 organization_id uuid NOT NULL,channel_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),
 instance_id uuid NOT NULL,actor_id uuid NOT NULL,binding_fingerprint text NOT NULL CHECK(binding_fingerprint ~ '^[a-f0-9]{64}$'),
 configuration_revision integer NOT NULL DEFAULT 2 CHECK(configuration_revision=2),
 expected_identity_revision bigint NOT NULL CHECK(expected_identity_revision>0),
 catalog_revision bigint NOT NULL CHECK(catalog_revision>=0),identity_revision bigint CHECK(identity_revision>0),
 identity_fingerprint text CHECK(identity_fingerprint ~ '^[a-f0-9]{64}$'),
 phase text NOT NULL CHECK(phase IN ('PREPARED','DISPATCHED','UNKNOWN','CONFIRMED')),
 lease_token uuid,lease_expires_at timestamptz,dispatched_at timestamptz,observed_at timestamptz,
 safe_error text CHECK(safe_error IN ('CONFIGURATION_UNAVAILABLE','CONFIGURATION_UNKNOWN','IDENTITY_CHANGED','LEASE_LOST','ACCESS_DENIED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,id),FOREIGN KEY(organization_id,channel_id) REFERENCES whatsapp_group_catalogs(organization_id,channel_id),
 FOREIGN KEY(organization_id,instance_id) REFERENCES instances(organization_id,id),
 CONSTRAINT whatsapp_group_webhook_lease CHECK((lease_token IS NULL)=(lease_expires_at IS NULL)),
 CONSTRAINT whatsapp_group_webhook_confirmation CHECK(phase<>'CONFIRMED' OR (identity_revision IS NOT NULL AND identity_fingerprint IS NOT NULL AND observed_at IS NOT NULL AND safe_error IS NULL)),
 CONSTRAINT whatsapp_group_webhook_dispatch CHECK(phase NOT IN ('DISPATCHED','UNKNOWN') OR dispatched_at IS NOT NULL)
);
CREATE UNIQUE INDEX whatsapp_group_webhook_one_unresolved ON whatsapp_group_webhook_operations(organization_id,channel_id)
 WHERE phase IN ('PREPARED','DISPATCHED','UNKNOWN');
CREATE INDEX whatsapp_group_webhook_channel_latest ON whatsapp_group_webhook_operations(organization_id,channel_id,created_at DESC,id);
--> statement-breakpoint
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['whatsapp_group_events','whatsapp_group_participation','whatsapp_group_participants','whatsapp_group_webhook_operations'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO jrc_migrator',name);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY group_events_tenant ON %I TO jrc_app USING(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',name);
  EXECUTE format('CREATE POLICY lifecycle_migrator ON %I TO jrc_migrator USING(true) WITH CHECK(true)',name);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth,jrc_platform',name);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO jrc_app',name);
  IF name<>'whatsapp_group_events' THEN EXECUTE format('GRANT UPDATE ON %I TO jrc_app',name); END IF;
  EXECUTE format('CREATE TRIGGER lifecycle_group_events_block BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_channel_write()',name);
  INSERT INTO lifecycle_purge_catalogue(table_name) VALUES(name);
 END LOOP;
END $$;
--> statement-breakpoint
DO $$ DECLARE original text; patched text; BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 patched=replace(original,'DELETE FROM public.whatsapp_group_catalog_items WHERE organization_id=org AND channel_id=channel;',
 'DELETE FROM public.whatsapp_group_webhook_operations WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.whatsapp_group_participants WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.whatsapp_group_participation WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.whatsapp_group_events WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.whatsapp_group_catalog_items WHERE organization_id=org AND channel_id=channel;');
 IF patched=original THEN RAISE EXCEPTION 'WHATSAPP_GROUP_EVENTS_PURGE_PATCH_TARGET_MISSING'; END IF;
 EXECUTE patched;
END $$;
