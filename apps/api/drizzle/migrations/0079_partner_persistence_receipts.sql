-- Additive opt-in ACK contract. Existing endpoints retain HTTP transport semantics.
ALTER TABLE partner_webhook_endpoints ADD COLUMN ack_mode text NOT NULL DEFAULT 'HTTP'
 CONSTRAINT partner_webhook_ack_mode CHECK(ack_mode IN ('HTTP','PERSISTENCE_RECEIPT_V1'));
ALTER TABLE partner_event_deliveries ADD COLUMN receipt_id uuid;
ALTER TABLE partner_event_deliveries ADD COLUMN receipt_persisted_at timestamptz;
ALTER TABLE partner_event_deliveries ADD COLUMN receipt_accepted_at timestamptz;
ALTER TABLE partner_event_deliveries ADD CONSTRAINT partner_delivery_receipt_complete CHECK(
 (receipt_id IS NULL AND receipt_persisted_at IS NULL AND receipt_accepted_at IS NULL) OR
 (receipt_id IS NOT NULL AND receipt_persisted_at IS NOT NULL AND receipt_accepted_at IS NOT NULL AND status='DELIVERED'));
CREATE UNIQUE INDEX partner_delivery_receipt_identity ON partner_event_deliveries(organization_id,endpoint_id,receipt_id) WHERE receipt_id IS NOT NULL;
GRANT UPDATE(receipt_id,receipt_persisted_at,receipt_accepted_at) ON partner_event_deliveries TO jrc_app;

-- Guard receipt evidence and keep an old binary from silently marking an opted-in
-- endpoint DELIVERED without a receipt. Evidence remains in the existing tenant
-- delivery ledger and follows its existing retention/lifecycle policy.
CREATE FUNCTION partner_delivery_receipt_fence() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,public AS $$
DECLARE mode text;
BEGIN
 IF OLD.receipt_id IS NOT NULL AND
  (NEW.receipt_id,NEW.receipt_persisted_at,NEW.receipt_accepted_at) IS DISTINCT FROM
  (OLD.receipt_id,OLD.receipt_persisted_at,OLD.receipt_accepted_at) THEN
  RAISE EXCEPTION 'PARTNER_RECEIPT_IMMUTABLE' USING ERRCODE='23514',CONSTRAINT='partner_receipt_immutable';
 END IF;
 IF NEW.status='DELIVERED' AND OLD.status<>'DELIVERED' THEN
  SELECT ack_mode INTO STRICT mode FROM public.partner_webhook_endpoints
   WHERE organization_id=NEW.organization_id AND id=NEW.endpoint_id;
  IF (mode='PERSISTENCE_RECEIPT_V1')<>(NEW.receipt_id IS NOT NULL) OR
   (NEW.receipt_id IS NOT NULL AND (OLD.status<>'RUNNING' OR OLD.lease_token IS NULL OR OLD.lease_expires_at<=now())) THEN
   RAISE EXCEPTION 'PARTNER_RECEIPT_REQUIRED' USING ERRCODE='23514',CONSTRAINT='partner_receipt_required';
  END IF;
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION partner_delivery_receipt_fence() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION partner_delivery_receipt_fence() FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
CREATE TRIGGER partner_delivery_receipt_fence BEFORE UPDATE ON partner_event_deliveries
 FOR EACH ROW EXECUTE FUNCTION partner_delivery_receipt_fence();
