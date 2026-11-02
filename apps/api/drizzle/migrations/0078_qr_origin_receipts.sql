-- Additive opt-in origin receipts. No payload, address, credential or automatic retention/deletion.
CREATE TABLE qr_origin_receipts (
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 channel_id uuid NOT NULL, source_event_id uuid NOT NULL, instance_id uuid NOT NULL,
 binding_fingerprint text NOT NULL CHECK(binding_fingerprint ~ '^[a-f0-9]{64}$'),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,channel_id,source_event_id),
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,instance_id) REFERENCES instances(organization_id,id) ON DELETE CASCADE
);
ALTER TABLE qr_origin_receipts OWNER TO jrc_migrator;
ALTER TABLE qr_origin_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE qr_origin_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY qr_origin_tenant ON qr_origin_receipts TO jrc_app
 USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY lifecycle_migrator ON qr_origin_receipts TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON qr_origin_receipts FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
GRANT SELECT,INSERT ON qr_origin_receipts TO jrc_app;
CREATE TRIGGER lifecycle_origin_receipt_block BEFORE INSERT ON qr_origin_receipts
 FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_channel_write();
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('qr_origin_receipts');
-- Keep the restricted readiness function in step with the new tenant-owned ledger.
CREATE OR REPLACE FUNCTION audit_corrections_catalogue_ready() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public AS $$
 SELECT count(*)=3 FROM public.lifecycle_purge_catalogue
  WHERE table_name IN ('media_custody_receipts','partner_delivery_replays','qr_origin_receipts')
$$;
ALTER FUNCTION audit_corrections_catalogue_ready() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION audit_corrections_catalogue_ready() FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
GRANT EXECUTE ON FUNCTION audit_corrections_catalogue_ready() TO jrc_app;
