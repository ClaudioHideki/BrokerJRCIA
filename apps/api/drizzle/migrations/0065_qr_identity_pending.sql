CREATE TABLE qr_identity_scopes (
 organization_id uuid NOT NULL,channel_id uuid NOT NULL,instance_id uuid NOT NULL,
 scope_id uuid NOT NULL DEFAULT gen_random_uuid(),owner_fingerprint text,upstream_instance_key text NOT NULL,
 binding_fingerprint text NOT NULL CHECK(binding_fingerprint ~ '^[a-f0-9]{64}$'),
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,channel_id),
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id),
 FOREIGN KEY(organization_id,instance_id) REFERENCES instances(organization_id,id),
 CHECK(owner_fingerprint IS NULL OR owner_fingerprint ~ '^[a-f0-9]{64}$')
);
CREATE TABLE qr_contact_aliases (
 organization_id uuid NOT NULL,channel_id uuid NOT NULL,scope_id uuid NOT NULL,lid text NOT NULL,
 phone text NOT NULL,status text NOT NULL DEFAULT 'CONFIRMED' CHECK(status IN ('CONFIRMED','CONFLICT')),
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,channel_id,scope_id,lid),
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id),
 CHECK(lid ~ '^[0-9]{1,30}@lid$'),CHECK(phone ~ '^[1-9][0-9]{7,14}$')
);
CREATE TABLE qr_identity_pending_events (
 organization_id uuid NOT NULL,channel_id uuid NOT NULL,scope_id uuid,lid text NOT NULL,
 provider_message_id text NOT NULL,event jsonb,body_hash text NOT NULL,occurred_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'WAITING',reason text NOT NULL DEFAULT 'LID_NUMBER_UNRESOLVED',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,channel_id,provider_message_id),
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id),
 CONSTRAINT qr_identity_pending_shape CHECK(status IN ('WAITING','RESOLVED','CONFLICT','STALE')
   AND (status<>'RESOLVED' OR event IS NULL)
   AND (event IS NULL OR (jsonb_typeof(event)='object' AND octet_length(event::text)<=24576))),
 CHECK(lid ~ '^[0-9]{1,30}@lid$'),CHECK(length(provider_message_id) BETWEEN 1 AND 256),
 CHECK(body_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX qr_identity_pending_due ON qr_identity_pending_events(organization_id,channel_id,scope_id,lid,occurred_at,provider_message_id) WHERE status='WAITING';
CREATE INDEX qr_identity_pending_unresolved ON qr_identity_pending_events(organization_id,channel_id,status) WHERE status IN ('WAITING','CONFLICT','STALE');
--> statement-breakpoint
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['qr_identity_scopes','qr_contact_aliases','qr_identity_pending_events'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO jrc_migrator',item);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',item);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',item);
  EXECUTE format('CREATE POLICY qr_identity_tenant ON %I TO jrc_app USING(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',item);
  EXECUTE format('CREATE POLICY lifecycle_migrator ON %I TO jrc_migrator USING(true) WITH CHECK(true)',item);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth,jrc_platform,jrc_lifecycle',item);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO jrc_app',item);
  EXECUTE format('CREATE TRIGGER qr_identity_channel_admission BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_channel_write()',item);
  INSERT INTO lifecycle_purge_catalogue(table_name) VALUES(item);
 END LOOP;
END $$;
--> statement-breakpoint
DO $$ DECLARE original text; patched text; BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 patched=replace(original,'DELETE FROM public.messaging_messages WHERE organization_id=org AND channel_id=channel;',
 'DELETE FROM public.qr_identity_pending_events WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.qr_contact_aliases WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.qr_identity_scopes WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.messaging_messages WHERE organization_id=org AND channel_id=channel;');
 IF patched=original THEN RAISE EXCEPTION 'QR_IDENTITY_PURGE_UPGRADE_MISMATCH'; END IF;
 EXECUTE patched;
END $$;
