-- Private catalogue only: discovered peers are not persisted messages or media receipts.
CREATE TABLE history_sync_peers (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), channel_id uuid NOT NULL,
 history_account_identity uuid NOT NULL, recipient_kind text NOT NULL CHECK(recipient_kind IN ('INDIVIDUAL','GROUP')),
 peer_jid text NOT NULL CHECK(length(peer_jid) BETWEEN 1 AND 128 AND (
   (recipient_kind='GROUP' AND peer_jid ~ '^[0-9]+(-[0-9]+)?@g[.]us$')
   OR (recipient_kind='INDIVIDUAL' AND peer_jid ~ '^([1-9][0-9]{7,14}@s[.]whatsapp[.]net|[0-9]{1,30}@lid)$'))),
 display_name text CHECK(length(display_name)<=512), last_message_at bigint CHECK(last_message_at BETWEEN 0 AND 9007199254740991),
 discovered_as_chat boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,channel_id,history_account_identity,recipient_kind,peer_jid),
 FOREIGN KEY(organization_id,channel_id,history_account_identity) REFERENCES history_account_identities(organization_id,channel_id,id)
);
CREATE INDEX history_sync_peers_activity ON history_sync_peers(organization_id,channel_id,history_account_identity,last_message_at DESC,id)
 WHERE discovered_as_chat;
CREATE FUNCTION history_sync_peer_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['display_name','last_message_at','discovered_as_chat','updated_at'])
  IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['display_name','last_message_at','discovered_as_chat','updated_at'])
  OR (OLD.discovered_as_chat AND NOT NEW.discovered_as_chat)
  OR (OLD.last_message_at IS NOT NULL AND (NEW.last_message_at IS NULL OR NEW.last_message_at<OLD.last_message_at)) THEN
   RAISE EXCEPTION 'HISTORY_SYNC_PEER_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION history_sync_peer_guard() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION history_sync_peer_guard() FROM PUBLIC;
CREATE TRIGGER history_sync_peer_guard BEFORE UPDATE ON history_sync_peers FOR EACH ROW EXECUTE FUNCTION history_sync_peer_guard();
--> statement-breakpoint
CREATE TABLE history_sync_catalogue_pages (
 organization_id uuid NOT NULL, channel_id uuid NOT NULL, run_id uuid NOT NULL, chunk_id uuid NOT NULL,
 checksum text NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'), record_count integer NOT NULL CHECK(record_count BETWEEN 0 AND 100),
 peer_count integer NOT NULL CHECK(peer_count BETWEEN 0 AND 100), chat_count integer NOT NULL CHECK(chat_count BETWEEN 0 AND peer_count),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,run_id,chunk_id),
 FOREIGN KEY(organization_id,channel_id,run_id) REFERENCES history_sync_runs(organization_id,channel_id,id),
 FOREIGN KEY(organization_id,run_id,chunk_id) REFERENCES history_sync_chunks(organization_id,run_id,chunk_id),
 CHECK(peer_count<=record_count)
);
--> statement-breakpoint
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['history_sync_peers','history_sync_catalogue_pages'] LOOP
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
GRANT UPDATE(display_name,last_message_at,discovered_as_chat,updated_at) ON history_sync_peers TO jrc_app;
--> statement-breakpoint
-- Extend the existing explicit deletion path; no automatic retention or removal.
DO $$ DECLARE original text; patched text; BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 patched=replace(original,'DELETE FROM public.history_sync_receipts WHERE organization_id=org AND channel_id=channel;',
 'DELETE FROM public.history_sync_catalogue_pages WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.history_sync_peers WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.history_sync_receipts WHERE organization_id=org AND channel_id=channel;');
 IF patched=original THEN RAISE EXCEPTION 'HISTORY_CATALOGUE_PURGE_UPGRADE_MISMATCH'; END IF;
 EXECUTE patched;
END $$;
