-- Native materialization is private and opt-in; this migration admits no capture or replay.
CREATE TABLE history_sync_native_peers (
 organization_id uuid NOT NULL,channel_id uuid NOT NULL,history_account_identity uuid NOT NULL,
 recipient_kind text NOT NULL CHECK(recipient_kind IN('INDIVIDUAL','GROUP')),chat_jid text NOT NULL,
 conversation_id uuid NOT NULL,contact_id uuid,
 bootstrap_occurred_at bigint NOT NULL CHECK(bootstrap_occurred_at BETWEEN 0 AND 9007199254740991),
 bootstrap_name text NOT NULL CHECK(length(bootstrap_name) BETWEEN 1 AND 512),
 PRIMARY KEY(organization_id,channel_id,history_account_identity,recipient_kind,chat_jid),
 UNIQUE(organization_id,channel_id,conversation_id),
 FOREIGN KEY(organization_id,channel_id,history_account_identity) REFERENCES history_account_identities(organization_id,channel_id,id),
 FOREIGN KEY(organization_id,channel_id,conversation_id) REFERENCES messaging_conversations(organization_id,channel_id,id),
 FOREIGN KEY(organization_id,contact_id) REFERENCES messaging_contacts(organization_id,id),
 CHECK((recipient_kind='GROUP' AND contact_id IS NULL AND chat_jid ~ '^[0-9]+(-[0-9]+)?@g[.]us$') OR
   (recipient_kind='INDIVIDUAL' AND contact_id IS NOT NULL AND chat_jid ~ '^([1-9][0-9]{7,14}@s[.]whatsapp[.]net|[0-9]{1,30}@lid)$'))
);
CREATE TABLE history_sync_record_results (
 organization_id uuid NOT NULL,channel_id uuid NOT NULL,run_id uuid NOT NULL,chunk_id uuid NOT NULL,
 record_index integer NOT NULL CHECK(record_index BETWEEN 0 AND 99),
 disposition text NOT NULL CHECK(disposition IN('CREATED','DUPLICATE','PEER','GAP','BLOCKED')),
 receipt_id uuid,message_id uuid,safe_code text CHECK(safe_code ~ '^[A-Z][A-Z0-9_]{0,95}$'),
 PRIMARY KEY(organization_id,run_id,chunk_id,record_index),
 FOREIGN KEY(organization_id,run_id,chunk_id) REFERENCES history_sync_chunks(organization_id,run_id,chunk_id),
 FOREIGN KEY(organization_id,channel_id,message_id) REFERENCES messaging_messages(organization_id,channel_id,id),
 FOREIGN KEY(organization_id,receipt_id) REFERENCES history_sync_receipts(organization_id,id),
 CHECK((disposition IN('CREATED','DUPLICATE') AND receipt_id IS NOT NULL AND message_id IS NOT NULL AND safe_code IS NULL)
  OR (disposition IN('BLOCKED','GAP') AND receipt_id IS NULL AND message_id IS NULL AND safe_code IS NOT NULL)
  OR (disposition='PEER' AND receipt_id IS NULL AND message_id IS NULL AND safe_code IS NULL))
);
CREATE TABLE history_sync_live_proofs (
 organization_id uuid NOT NULL,channel_id uuid NOT NULL,message_id uuid NOT NULL,
 identity_scope_id uuid NOT NULL,binding_fingerprint text NOT NULL CHECK(binding_fingerprint ~ '^[a-f0-9]{64}$'),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(organization_id,message_id),
 FOREIGN KEY(organization_id,channel_id,message_id) REFERENCES messaging_messages(organization_id,channel_id,id)
);
CREATE TABLE history_sync_deliveries (
 organization_id uuid NOT NULL,channel_id uuid NOT NULL,run_id uuid NOT NULL,chunk_id uuid NOT NULL,record_index integer NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),state text NOT NULL DEFAULT 'PENDING' CHECK(state IN('PENDING','WAITING_MEDIA','DONE','BLOCKED')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),next_attempt_at timestamptz NOT NULL DEFAULT now(),
 destination jsonb,authority_fingerprint text CHECK(authority_fingerprint ~ '^[a-f0-9]{64}$'),receipt jsonb,
 lease_token uuid,lease_until timestamptz,last_error text CHECK(last_error ~ '^[A-Z][A-Z0-9_]{0,95}$'),
 PRIMARY KEY(organization_id,id),UNIQUE(organization_id,run_id,chunk_id,record_index),
 FOREIGN KEY(organization_id,run_id,chunk_id,record_index) REFERENCES history_sync_record_results(organization_id,run_id,chunk_id,record_index),
 CHECK((destination IS NULL)=(authority_fingerprint IS NULL)),
 CHECK((lease_token IS NULL)=(lease_until IS NULL)),
 CHECK(state<>'DONE' OR receipt->>'state'='PERSISTED')
);
CREATE INDEX history_sync_deliveries_due ON history_sync_deliveries(organization_id,run_id,next_attempt_at,id) WHERE state IN('PENDING','WAITING_MEDIA');
CREATE TABLE history_sync_remote_peers (
 organization_id uuid NOT NULL,channel_id uuid NOT NULL,history_account_identity uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),integration_id uuid NOT NULL,destination_revision integer NOT NULL CHECK(destination_revision>0),
 account_id bigint NOT NULL CHECK(account_id>0),inbox_id bigint NOT NULL CHECK(inbox_id>0),conversation_id uuid NOT NULL,
 existing_conversation_id bigint CHECK(existing_conversation_id>0),receipt jsonb,
 PRIMARY KEY(organization_id,id),UNIQUE(organization_id,integration_id,destination_revision,conversation_id),
 FOREIGN KEY(organization_id,channel_id,conversation_id) REFERENCES history_sync_native_peers(organization_id,channel_id,conversation_id)
);
--> statement-breakpoint
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['history_sync_native_peers','history_sync_record_results','history_sync_live_proofs','history_sync_deliveries','history_sync_remote_peers'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO jrc_migrator',item);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',item);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',item);
  EXECUTE format('CREATE POLICY history_sync_tenant ON %I TO jrc_app USING(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',item);
  EXECUTE format('CREATE POLICY lifecycle_migrator ON %I TO jrc_migrator USING(true) WITH CHECK(true)',item);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth,jrc_platform,jrc_lifecycle,jrc_app',item);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO jrc_app',item);
  EXECUTE format('CREATE TRIGGER history_sync_channel_admission BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_channel_write()',item);
  INSERT INTO lifecycle_purge_catalogue(table_name) VALUES(item);
 END LOOP;
END $$;
GRANT UPDATE ON history_sync_deliveries TO jrc_app;
GRANT UPDATE(receipt) ON history_sync_remote_peers TO jrc_app;
CREATE FUNCTION history_sync_delivery_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF ROW(NEW.organization_id,NEW.channel_id,NEW.run_id,NEW.chunk_id,NEW.record_index,NEW.id)
    IS DISTINCT FROM ROW(OLD.organization_id,OLD.channel_id,OLD.run_id,OLD.chunk_id,OLD.record_index,OLD.id)
 OR (OLD.destination IS NOT NULL AND ROW(NEW.destination,NEW.authority_fingerprint) IS DISTINCT FROM ROW(OLD.destination,OLD.authority_fingerprint))
 OR OLD.state='DONE' AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'HISTORY_SYNC_DELIVERY_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION history_sync_delivery_guard() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION history_sync_delivery_guard() FROM PUBLIC;
CREATE TRIGGER history_sync_delivery_guard BEFORE UPDATE ON history_sync_deliveries FOR EACH ROW EXECUTE FUNCTION history_sync_delivery_guard();
--> statement-breakpoint
-- Preserve explicit lifecycle deletion and KEEP. No automatic deletion is added.
DO $$ DECLARE original text; patched text; BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 patched=replace(original,'DELETE FROM public.history_sync_catalogue_pages WHERE organization_id=org AND channel_id=channel;',
 'DELETE FROM public.history_sync_remote_peers WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.history_sync_deliveries WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.history_sync_record_results WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.history_sync_live_proofs WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.history_sync_native_peers WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.history_sync_catalogue_pages WHERE organization_id=org AND channel_id=channel;');
 IF patched=original THEN RAISE EXCEPTION 'HISTORY_MATERIALIZATION_PURGE_UPGRADE_MISMATCH'; END IF;
 EXECUTE patched;
END $$;
