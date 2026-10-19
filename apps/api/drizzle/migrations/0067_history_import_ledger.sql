-- This migration is still unpublished. Snapshot payloads are private tenant data,
-- frozen once from a read-only provider transaction and never updated by runtime.
ALTER TABLE messaging_messages ADD COLUMN is_historical boolean NOT NULL DEFAULT false;
ALTER TABLE integration_jobs DROP CONSTRAINT integration_jobs_status_check,
 ADD CONSTRAINT integration_jobs_status_check CHECK(status IN ('PENDING','HISTORY_PENDING','RUNNING','SUCCEEDED','FAILED','UNKNOWN'));
CREATE OR REPLACE FUNCTION enqueue_chatwoot_mirror() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.state=OLD.state THEN RETURN NEW; END IF;
 INSERT INTO public.integration_jobs(organization_id,integration_id,kind,dedupe_key,message_id,payload,status)
 SELECT NEW.organization_id,c.id,'MIRROR_MESSAGE','message:'||NEW.id::text||':'||NEW.state::text,NEW.id,
   CASE WHEN NEW.is_historical THEN '{"historical":true}'::jsonb ELSE '{}'::jsonb END,
   CASE WHEN NEW.is_historical THEN 'HISTORY_PENDING' ELSE 'PENDING' END
 FROM public.chatwoot_connections c JOIN public.messaging_channels m ON m.organization_id=c.organization_id AND m.id=c.channel_id
 WHERE c.organization_id=NEW.organization_id AND c.channel_id=NEW.channel_id AND c.status IN ('READY','DISABLED')
   AND m.transport='BROKER_TRANSPORT'
 ON CONFLICT(organization_id,integration_id,dedupe_key) DO NOTHING;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TABLE history_import_snapshots (
 organization_id uuid NOT NULL,id uuid NOT NULL,channel_id uuid NOT NULL,request_id uuid NOT NULL,
 payload jsonb NOT NULL,expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,id),UNIQUE(organization_id,request_id),
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id),
 CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=16777216)
);
CREATE INDEX history_import_snapshot_expiry ON history_import_snapshots(organization_id,expires_at);
CREATE TABLE history_import_jobs (
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),channel_id uuid NOT NULL,request_id uuid NOT NULL,
 manifest jsonb NOT NULL,fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 max_records bigint NOT NULL CHECK(max_records BETWEEN 1 AND 9007199254740991),
 total_records bigint NOT NULL CHECK(total_records BETWEEN 0 AND 9007199254740991),
 next_ordinal bigint NOT NULL DEFAULT 0,imported_count bigint NOT NULL DEFAULT 0,duplicate_count bigint NOT NULL DEFAULT 0,
 state text NOT NULL CHECK(state IN ('OPEN','COMPLETED','CANCELED')),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 actor_id uuid,next_attempt_at timestamptz NOT NULL DEFAULT now(),last_error text CHECK(last_error IS NULL OR last_error ~ '^[A-Z][A-Z0-9_]{0,127}$'),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id),UNIQUE(organization_id,request_id),UNIQUE(organization_id,channel_id,id),
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id),
 CHECK(total_records<=max_records AND next_ordinal BETWEEN 0 AND total_records AND imported_count>=0 AND duplicate_count>=0
  AND imported_count+duplicate_count=next_ordinal AND ((state='COMPLETED')=(next_ordinal=total_records))),
 CHECK((jsonb_typeof(manifest)='object' AND manifest->>'schemaVersion'='1' AND manifest->>'organizationId'=organization_id::text
  AND manifest->>'channelId'=channel_id::text AND manifest->>'totalRecords'=total_records::text AND octet_length(manifest::text)<=1048576) IS TRUE)
);
CREATE INDEX history_import_open ON history_import_jobs(organization_id,next_attempt_at,created_at,id) WHERE state='OPEN' AND actor_id IS NOT NULL;
CREATE TABLE history_import_pages (
 organization_id uuid NOT NULL,channel_id uuid NOT NULL,import_id uuid NOT NULL,start_ordinal bigint NOT NULL,
 next_ordinal bigint NOT NULL,checksum text NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'),
 imported_count bigint NOT NULL CHECK(imported_count>=0),duplicate_count bigint NOT NULL CHECK(duplicate_count>=0),actor_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,import_id,start_ordinal),
 FOREIGN KEY(organization_id,channel_id,import_id) REFERENCES history_import_jobs(organization_id,channel_id,id),
 CHECK(start_ordinal>=0 AND start_ordinal%100=0 AND next_ordinal>start_ordinal AND next_ordinal-start_ordinal<=100
   AND imported_count+duplicate_count=next_ordinal-start_ordinal)
);
--> statement-breakpoint
CREATE FUNCTION history_import_job_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.next_ordinal<>0 OR NEW.imported_count<>0 OR NEW.duplicate_count<>0 OR NEW.revision<>1
   OR NEW.state<>(CASE WHEN NEW.total_records=0 THEN 'COMPLETED' ELSE 'OPEN' END) THEN
   RAISE EXCEPTION 'HISTORY_IMPORT_INVALID_INITIAL_STATE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF (NEW.organization_id,NEW.id,NEW.channel_id,NEW.request_id,NEW.manifest,NEW.fingerprint,NEW.max_records,NEW.total_records,NEW.created_at)
 IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.channel_id,OLD.request_id,OLD.manifest,OLD.fingerprint,OLD.max_records,OLD.total_records,OLD.created_at)
 OR OLD.state<>'OPEN' OR NEW.revision<>OLD.revision+1 THEN
  RAISE EXCEPTION 'HISTORY_IMPORT_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 IF NEW.next_ordinal<>OLD.next_ordinal THEN
  IF NEW.next_ordinal<OLD.next_ordinal OR NOT EXISTS(SELECT 1 FROM public.history_import_pages p
    WHERE p.organization_id=OLD.organization_id AND p.import_id=OLD.id AND p.start_ordinal=OLD.next_ordinal
      AND p.next_ordinal=NEW.next_ordinal AND p.imported_count=NEW.imported_count-OLD.imported_count
      AND p.duplicate_count=NEW.duplicate_count-OLD.duplicate_count
      AND p.actor_id IS NOT DISTINCT FROM NEW.actor_id
      AND p.checksum=OLD.manifest->'pageDigests'->>(OLD.next_ordinal/100)::integer) THEN
   RAISE EXCEPTION 'HISTORY_IMPORT_CHECKPOINT_WITHOUT_RECEIPT' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.imported_count<>OLD.imported_count OR NEW.duplicate_count<>OLD.duplicate_count OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
  OR (NEW.state<>'CANCELED' AND NOT(NEW.state='OPEN' AND NEW.last_error IS NOT NULL AND NEW.next_attempt_at>OLD.next_attempt_at)) THEN
  RAISE EXCEPTION 'HISTORY_IMPORT_INVALID_TRANSITION' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION history_import_job_immutable() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION history_import_job_immutable() FROM PUBLIC;
CREATE TRIGGER history_import_job_guard BEFORE INSERT OR UPDATE ON history_import_jobs FOR EACH ROW EXECUTE FUNCTION history_import_job_immutable();
--> statement-breakpoint
CREATE FUNCTION history_import_receipt_checkpoint() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.history_import_jobs j
   WHERE j.organization_id=NEW.organization_id AND j.channel_id=NEW.channel_id AND j.id=NEW.import_id
     AND j.next_ordinal>=NEW.next_ordinal AND NEW.next_ordinal=LEAST(NEW.start_ordinal+100,j.total_records)
     AND NEW.checksum=j.manifest->'pageDigests'->>(NEW.start_ordinal/100)::integer) THEN
  RAISE EXCEPTION 'HISTORY_IMPORT_RECEIPT_WITHOUT_CHECKPOINT' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION history_import_receipt_checkpoint() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION history_import_receipt_checkpoint() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER history_import_receipt_checkpoint AFTER INSERT ON history_import_pages
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION history_import_receipt_checkpoint();
--> statement-breakpoint
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['history_import_jobs','history_import_pages','history_import_snapshots'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO jrc_migrator',item);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',item);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',item);
  EXECUTE format('CREATE POLICY history_import_tenant ON %I TO jrc_app USING(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',item);
  EXECUTE format('CREATE POLICY lifecycle_migrator ON %I TO jrc_migrator USING(true) WITH CHECK(true)',item);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth,jrc_platform,jrc_lifecycle',item);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO jrc_app',item);
  EXECUTE format('CREATE TRIGGER history_import_channel_admission BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_channel_write()',item);
  INSERT INTO lifecycle_purge_catalogue(table_name) VALUES(item);
 END LOOP;
END $$;
GRANT UPDATE ON history_import_jobs TO jrc_app;
--> statement-breakpoint
CREATE FUNCTION history_import_expire_snapshots() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DELETE FROM public.history_import_snapshots WHERE organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid AND expires_at<=statement_timestamp()
$$;
ALTER FUNCTION history_import_expire_snapshots() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION history_import_expire_snapshots() FROM PUBLIC,jrc_auth,jrc_platform,jrc_lifecycle;
GRANT EXECUTE ON FUNCTION history_import_expire_snapshots() TO jrc_app;
--> statement-breakpoint
DO $$ DECLARE original text; patched text; BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 patched=replace(original,'DELETE FROM public.qr_identity_pending_events WHERE organization_id=org AND channel_id=channel;',
 'DELETE FROM public.history_import_pages WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.history_import_jobs WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.history_import_snapshots WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.qr_identity_pending_events WHERE organization_id=org AND channel_id=channel;');
 IF patched=original THEN RAISE EXCEPTION 'HISTORY_IMPORT_PURGE_UPGRADE_MISMATCH'; END IF;
 EXECUTE patched;
END $$;
