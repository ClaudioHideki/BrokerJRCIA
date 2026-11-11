-- Additive private V2 ledger. No live callbacks, worker admission or retention deletion.
CREATE TABLE history_account_identities (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), channel_id uuid NOT NULL,
 owner_fingerprint text NOT NULL CHECK(owner_fingerprint ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,id),
 UNIQUE(organization_id,channel_id,id), UNIQUE(organization_id,channel_id,owner_fingerprint),
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id)
);
--> statement-breakpoint
CREATE TABLE history_sync_runs (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), channel_id uuid NOT NULL,
 instance_id uuid NOT NULL, request_id uuid NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 engine_id text NOT NULL CHECK(engine_id ~ '^[a-z][a-z0-9_-]{0,63}$'), engine_generation bigint NOT NULL CHECK(engine_generation BETWEEN 1 AND 9007199254740991),
 session_generation uuid NOT NULL, binding_fingerprint text NOT NULL CHECK(binding_fingerprint ~ '^[a-f0-9]{64}$'),
 history_account_identity uuid, identity_scope_id uuid, owner_fingerprint text,
 categories text[] NOT NULL CHECK(cardinality(categories) BETWEEN 1 AND 3 AND categories <@ ARRAY['INDIVIDUAL','GROUP','MEDIA']::text[]
   AND categories && ARRAY['INDIVIDUAL','GROUP']::text[] AND array_position(categories,NULL) IS NULL AND cardinality(array_positions(categories,'INDIVIDUAL'))<=1
   AND cardinality(array_positions(categories,'GROUP'))<=1 AND cardinality(array_positions(categories,'MEDIA'))<=1),
 state text NOT NULL DEFAULT 'RUNNING' CHECK(state IN ('RUNNING','PAUSED','CANCELED','COMPLETED','PARTIAL','BLOCKED')),
 capture text NOT NULL DEFAULT 'WAITING_IDENTITY' CHECK(capture IN ('WAITING_IDENTITY','CAPTURING','COMPLETE','PARTIAL','BLOCKED')),
 persistence text NOT NULL DEFAULT 'PENDING' CHECK(persistence IN ('PENDING','RUNNING','COMPLETE','BLOCKED')),
 projection text NOT NULL DEFAULT 'NOT_CONFIGURED' CHECK(projection IN ('NOT_CONFIGURED','PENDING','RUNNING','COMPLETE','BLOCKED')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
 next_ordinal bigint NOT NULL DEFAULT 0 CHECK(next_ordinal BETWEEN 0 AND 9007199254740991),
 chats bigint NOT NULL DEFAULT 0, captured_messages bigint NOT NULL DEFAULT 0,
 persisted_messages bigint NOT NULL DEFAULT 0, duplicate_messages bigint NOT NULL DEFAULT 0,
 projected_messages bigint NOT NULL DEFAULT 0, pending_media bigint NOT NULL DEFAULT 0,
 verified_media bigint NOT NULL DEFAULT 0, unavailable_media bigint NOT NULL DEFAULT 0, blocked_records bigint NOT NULL DEFAULT 0,
 source_total_known boolean NOT NULL DEFAULT false,
 last_error text CHECK(last_error ~ '^[A-Z][A-Z0-9_]{0,95}$'),
 next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,channel_id,id), UNIQUE(organization_id,channel_id,request_id),
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id),
 FOREIGN KEY(organization_id,instance_id) REFERENCES instances(organization_id,id),
 FOREIGN KEY(organization_id,channel_id,history_account_identity) REFERENCES history_account_identities(organization_id,channel_id,id),
 CHECK((history_account_identity IS NULL AND identity_scope_id IS NULL AND owner_fingerprint IS NULL AND capture='WAITING_IDENTITY')
   OR (history_account_identity IS NOT NULL AND identity_scope_id IS NOT NULL AND owner_fingerprint IS NOT NULL AND owner_fingerprint ~ '^[a-f0-9]{64}$' AND capture<>'WAITING_IDENTITY')),
 CHECK(LEAST(chats,captured_messages,persisted_messages,duplicate_messages,projected_messages,pending_media,verified_media,unavailable_media,blocked_records)>=0
   AND GREATEST(chats,captured_messages,persisted_messages,duplicate_messages,projected_messages,pending_media,verified_media,unavailable_media,blocked_records)<=9007199254740991
   AND persisted_messages+duplicate_messages<=captured_messages AND projected_messages<=persisted_messages),
 CHECK(state<>'COMPLETED' OR (capture='COMPLETE' AND persistence='COMPLETE' AND projection IN ('COMPLETE','NOT_CONFIGURED')
   AND persisted_messages+duplicate_messages=captured_messages AND (projection<>'COMPLETE' OR projected_messages=persisted_messages)
   AND pending_media=0 AND unavailable_media=0 AND blocked_records=0))
);
CREATE INDEX history_sync_pending ON history_sync_runs(organization_id,next_attempt_at,id) WHERE state='RUNNING';
CREATE FUNCTION history_sync_run_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.organization_id,NEW.id,NEW.channel_id,NEW.instance_id,NEW.request_id,NEW.request_hash,NEW.engine_id,NEW.engine_generation,
    NEW.session_generation,NEW.binding_fingerprint,NEW.categories,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.organization_id,OLD.id,OLD.channel_id,OLD.instance_id,OLD.request_id,OLD.request_hash,OLD.engine_id,OLD.engine_generation,
    OLD.session_generation,OLD.binding_fingerprint,OLD.categories,OLD.created_at)
   OR (OLD.history_account_identity IS NOT NULL AND ROW(NEW.history_account_identity,NEW.identity_scope_id,NEW.owner_fingerprint)
     IS DISTINCT FROM ROW(OLD.history_account_identity,OLD.identity_scope_id,OLD.owner_fingerprint))
   OR NEW.revision<OLD.revision OR NEW.next_ordinal<OLD.next_ordinal
   OR (OLD.state IN ('COMPLETED','CANCELED') AND NEW IS DISTINCT FROM OLD) THEN
   RAISE EXCEPTION 'HISTORY_SYNC_RUN_IMMUTABLE' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.history_account_identity IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.history_account_identities i
   WHERE i.organization_id=NEW.organization_id AND i.channel_id=NEW.channel_id AND i.id=NEW.history_account_identity AND i.owner_fingerprint=NEW.owner_fingerprint) THEN
  RAISE EXCEPTION 'HISTORY_SYNC_OWNER_CONFLICT' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION history_sync_run_guard() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION history_sync_run_guard() FROM PUBLIC;
CREATE TRIGGER history_sync_run_guard BEFORE INSERT OR UPDATE ON history_sync_runs FOR EACH ROW EXECUTE FUNCTION history_sync_run_guard();
--> statement-breakpoint
CREATE TABLE history_sync_chunks (
 admission_kind text NOT NULL CHECK(admission_kind IN ('STAGED','VALIDATED')),
 organization_id uuid NOT NULL, channel_id uuid NOT NULL, run_id uuid NOT NULL, chunk_id uuid NOT NULL,
 ordinal bigint NOT NULL CHECK(ordinal BETWEEN 0 AND 9007199254740991), checksum text NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'),
 scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
 captured_at timestamptz NOT NULL, is_last boolean NOT NULL, progress integer CHECK(progress BETWEEN 0 AND 100),
 record_count integer NOT NULL CHECK(record_count BETWEEN 0 AND 100),
 state text NOT NULL DEFAULT 'PROVISIONAL' CHECK(state IN ('PROVISIONAL','VALIDATED','PERSISTED','QUARANTINED')),
 -- AES-256-GCM envelope, with organization/run/chunk/scope bound as authenticated data.
 private_payload jsonb NOT NULL CHECK(jsonb_typeof(private_payload)='object' AND octet_length(private_payload::text)<=1500000),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,run_id,chunk_id), UNIQUE(organization_id,run_id,ordinal),
 FOREIGN KEY(organization_id,channel_id,run_id) REFERENCES history_sync_runs(organization_id,channel_id,id)
);
CREATE INDEX history_sync_chunk_pending ON history_sync_chunks(organization_id,run_id,ordinal) WHERE state IN ('PROVISIONAL','VALIDATED');
CREATE UNIQUE INDEX history_sync_terminal_chunk ON history_sync_chunks(organization_id,run_id) WHERE is_last;
CREATE FUNCTION history_sync_chunk_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state')
  OR (NEW.state<>OLD.state AND NOT ((OLD.state='PROVISIONAL' AND NEW.state IN ('VALIDATED','QUARANTINED'))
    OR (OLD.state='VALIDATED' AND NEW.state IN ('PERSISTED','QUARANTINED')))) THEN
  RAISE EXCEPTION 'HISTORY_SYNC_CHUNK_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION history_sync_chunk_guard() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION history_sync_chunk_guard() FROM PUBLIC;
CREATE TRIGGER history_sync_chunk_guard BEFORE UPDATE ON history_sync_chunks FOR EACH ROW EXECUTE FUNCTION history_sync_chunk_guard();
--> statement-breakpoint
CREATE TABLE history_sync_receipts (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), channel_id uuid NOT NULL,
 history_account_identity uuid NOT NULL, recipient_kind text NOT NULL CHECK(recipient_kind IN ('INDIVIDUAL','GROUP')),
 chat_jid text NOT NULL CHECK(length(chat_jid) BETWEEN 1 AND 128), provider_message_id text NOT NULL CHECK(length(provider_message_id) BETWEEN 1 AND 256),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'), message_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,id),
 UNIQUE(organization_id,channel_id,history_account_identity,recipient_kind,chat_jid,provider_message_id),
 FOREIGN KEY(organization_id,channel_id,history_account_identity) REFERENCES history_account_identities(organization_id,channel_id,id),
 FOREIGN KEY(organization_id,channel_id,message_id) REFERENCES messaging_messages(organization_id,channel_id,id)
);
--> statement-breakpoint
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['history_account_identities','history_sync_runs','history_sync_chunks','history_sync_receipts'] LOOP
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
GRANT UPDATE ON history_sync_runs,history_sync_chunks TO jrc_app;
-- Identity upsert can only repeat its immutable fingerprint, never replace an owner.
GRANT UPDATE(owner_fingerprint) ON history_account_identities TO jrc_app;
CREATE FUNCTION history_sync_identity_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'HISTORY_SYNC_IDENTITY_IMMUTABLE' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
ALTER FUNCTION history_sync_identity_immutable() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION history_sync_identity_immutable() FROM PUBLIC;
CREATE TRIGGER history_sync_identity_immutable BEFORE UPDATE ON history_account_identities FOR EACH ROW EXECUTE FUNCTION history_sync_identity_immutable();
--> statement-breakpoint
-- Extend only the existing explicit lifecycle deletion, not an automatic retention policy.
DO $$ DECLARE original text; patched text; BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 patched=replace(original,'DELETE FROM public.history_import_pages WHERE organization_id=org AND channel_id=channel;',
 'DELETE FROM public.history_sync_receipts WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.history_sync_chunks WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.history_sync_runs WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.history_account_identities WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.history_import_pages WHERE organization_id=org AND channel_id=channel;');
 IF patched=original THEN RAISE EXCEPTION 'HISTORY_SYNC_PURGE_UPGRADE_MISMATCH'; END IF;
 EXECUTE patched;
END $$;
