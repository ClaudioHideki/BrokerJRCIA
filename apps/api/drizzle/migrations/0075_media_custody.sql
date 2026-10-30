-- Client attestation only. KEEP is the sole policy in this increment. No byte GC.
-- Include media_id in the message FK so a recorded receipt cannot silently follow
-- a later edit that changes the attachment of the original message.
ALTER TABLE messaging_messages ADD CONSTRAINT messaging_messages_custody_reference_unique
 UNIQUE(organization_id,channel_id,id,media_id);
CREATE TABLE media_custody_receipts (
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 id uuid NOT NULL DEFAULT gen_random_uuid(),schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version=1),
 channel_id uuid NOT NULL,message_id uuid NOT NULL,media_id uuid NOT NULL,endpoint_id uuid NOT NULL,
 destination_version integer NOT NULL CHECK(destination_version=1),client_receipt_id uuid NOT NULL,
 authorizing_api_key_id uuid NOT NULL, -- retained identity, not an FK to deletable credentials
 idempotency_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 16777216),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 storage_object_id text NOT NULL CHECK(length(storage_object_id) BETWEEN 1 AND 255 AND storage_object_id ~ '^[A-Za-z0-9_./:-]+$' AND position('://' IN storage_object_id)=0),
 attestation text NOT NULL CHECK(attestation='DURABLY_STORED'),
 retention_policy text NOT NULL DEFAULT 'KEEP' CHECK(retention_policy='KEEP'),
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,id),UNIQUE(organization_id,idempotency_key),
 UNIQUE(organization_id,endpoint_id,client_receipt_id),UNIQUE(organization_id,endpoint_id,message_id,media_id),
 FOREIGN KEY(organization_id,channel_id,message_id,media_id)
  REFERENCES messaging_messages(organization_id,channel_id,id,media_id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,channel_id,media_id) REFERENCES messaging_media(organization_id,channel_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,endpoint_id) REFERENCES partner_webhook_endpoints(organization_id,id) ON DELETE RESTRICT
);
ALTER TABLE media_custody_receipts OWNER TO jrc_migrator;
ALTER TABLE media_custody_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_custody_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY media_custody_tenant ON media_custody_receipts TO jrc_app
 USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY lifecycle_migrator ON media_custody_receipts TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON media_custody_receipts FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
GRANT SELECT,INSERT ON media_custody_receipts TO jrc_app;

-- Keep authority and reference validation at the SQL boundary as well as HTTP.
-- Order: organization -> key -> instance -> channel -> destination -> message/media.
CREATE FUNCTION media_custody_require_authority() RETURNS trigger LANGUAGE plpgsql
 SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE asset record;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'MEDIA_CUSTODY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NOT public.tenant_is_active(NEW.organization_id) THEN
  RAISE EXCEPTION 'ORGANIZATION_NOT_ACTIVE' USING ERRCODE='23514',CONSTRAINT='tenant_organization_active'; END IF;
 PERFORM k.id FROM public.api_keys k WHERE k.organization_id=NEW.organization_id AND k.id=NEW.authorizing_api_key_id
  AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp())
  AND k.scopes @> ARRAY['media:archive']::text[]
  AND NOT EXISTS(SELECT 1 FROM public.chatwoot_control_bindings b WHERE b.organization_id=k.organization_id AND b.api_key_id=k.id)
  FOR SHARE OF k;
 IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_CUSTODY_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM i.id FROM public.instances i JOIN public.messaging_channels c ON c.organization_id=i.organization_id AND c.instance_id=i.id
  WHERE c.organization_id=NEW.organization_id AND c.id=NEW.channel_id FOR SHARE OF i;
 PERFORM c.id FROM public.messaging_channels c WHERE c.organization_id=NEW.organization_id AND c.id=NEW.channel_id FOR SHARE;
 PERFORM e.id FROM public.partner_webhook_endpoints e WHERE e.organization_id=NEW.organization_id AND e.id=NEW.endpoint_id AND e.status='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_DESTINATION_NOT_ACTIVE' USING ERRCODE='23514'; END IF;
 SELECT a.status,a.byte_size,a.sha256 INTO asset FROM public.messaging_messages m JOIN public.messaging_media a
  ON a.organization_id=m.organization_id AND a.channel_id=m.channel_id AND a.id=m.media_id
  WHERE m.organization_id=NEW.organization_id AND m.channel_id=NEW.channel_id AND m.id=NEW.message_id AND a.id=NEW.media_id
  FOR SHARE OF m,a;
 IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_REFERENCE_NOT_FOUND' USING ERRCODE='23514'; END IF;
 IF asset.status<>'READY' OR asset.byte_size IS DISTINCT FROM NEW.byte_size OR asset.sha256 IS DISTINCT FROM NEW.sha256 THEN
  RAISE EXCEPTION 'MEDIA_CUSTODY_INTEGRITY_MISMATCH' USING ERRCODE='23514'; END IF;
 -- All blocking locks are acquired; wall-clock expiry must still authorize now.
 IF NOT EXISTS(SELECT 1 FROM public.api_keys k WHERE k.organization_id=NEW.organization_id AND k.id=NEW.authorizing_api_key_id
  AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp()) AND k.scopes @> ARRAY['media:archive']::text[]) THEN
  RAISE EXCEPTION 'MEDIA_CUSTODY_FORBIDDEN' USING ERRCODE='42501'; END IF;
 NEW.accepted_at=clock_timestamp();
 RETURN NEW;
END $$;
ALTER FUNCTION media_custody_require_authority() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION media_custody_require_authority() FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
CREATE TRIGGER a_media_custody_authority BEFORE INSERT OR UPDATE ON media_custody_receipts
 FOR EACH ROW EXECUTE FUNCTION media_custody_require_authority();
CREATE TRIGGER media_custody_lifecycle_admission BEFORE INSERT ON media_custody_receipts
 FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_channel_write();
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('media_custody_receipts');
-- Existing explicit lifecycle deletion remains authoritative. Delete this
-- metadata before message/media parents only within that guarded operation.
DO $$ DECLARE original text; patched text; BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 patched=replace(original,'DELETE FROM public.messaging_messages WHERE organization_id=org AND channel_id=channel;',
 'DELETE FROM public.media_custody_receipts WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.messaging_messages WHERE organization_id=org AND channel_id=channel;');
 IF patched=original THEN RAISE EXCEPTION 'MEDIA_CUSTODY_PURGE_UPGRADE_MISMATCH'; END IF;
 EXECUTE patched;
END $$;
