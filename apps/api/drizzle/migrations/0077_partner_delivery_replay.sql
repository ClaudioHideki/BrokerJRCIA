-- B12: explicitly replay FAILED partner HTTP deliveries only. This operation never
-- writes messaging messages/outboxes or re-sends a WhatsApp message.
ALTER TABLE partner_event_deliveries ADD COLUMN lifetime_attempts bigint NOT NULL DEFAULT 0 CHECK(lifetime_attempts>=0);
ALTER TABLE partner_event_deliveries ADD COLUMN replay_count integer NOT NULL DEFAULT 0 CHECK(replay_count>=0);
UPDATE partner_event_deliveries SET lifetime_attempts=attempts;
ALTER TABLE partner_event_deliveries ADD CONSTRAINT partner_delivery_replay_identity
 UNIQUE(organization_id,id,endpoint_id,event_id);
CREATE TABLE partner_delivery_replays (
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 id uuid NOT NULL DEFAULT gen_random_uuid(),schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version=1),
 authorizing_api_key_id uuid NOT NULL, -- stable identity even if a credential is later deleted
 idempotency_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 delivery_id uuid NOT NULL,endpoint_id uuid NOT NULL,event_id uuid NOT NULL,
 prior_attempts integer NOT NULL CHECK(prior_attempts BETWEEN 0 AND 10),prior_error_code text,
 replay_number integer NOT NULL CHECK(replay_number>0),accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,id),UNIQUE(organization_id,authorizing_api_key_id,idempotency_key),
 UNIQUE(organization_id,delivery_id,replay_number),
 FOREIGN KEY(organization_id,delivery_id,endpoint_id,event_id) REFERENCES partner_event_deliveries(organization_id,id,endpoint_id,event_id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,endpoint_id) REFERENCES partner_webhook_endpoints(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,event_id) REFERENCES partner_events(organization_id,id) ON DELETE CASCADE
);
ALTER TABLE partner_delivery_replays OWNER TO jrc_migrator;
ALTER TABLE partner_delivery_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_delivery_replays FORCE ROW LEVEL SECURITY;
CREATE POLICY partner_replay_tenant ON partner_delivery_replays TO jrc_app
 USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY lifecycle_migrator ON partner_delivery_replays TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON partner_delivery_replays FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
GRANT SELECT ON partner_delivery_replays TO jrc_app;
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('partner_delivery_replays');

CREATE FUNCTION partner_delivery_replay_immutable() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' OR current_user<>'jrc_migrator' THEN
  RAISE EXCEPTION 'PARTNER_REPLAY_IMMUTABLE' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION partner_delivery_replay_immutable() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION partner_delivery_replay_immutable() FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
CREATE TRIGGER partner_delivery_replay_immutable BEFORE INSERT OR UPDATE ON partner_delivery_replays
 FOR EACH ROW EXECUTE FUNCTION partner_delivery_replay_immutable();

-- Runtime retains its old worker grants, but cannot lower attempts or forge a
-- new cycle. Cumulative attempts increase on claims, not on their settlements.
CREATE FUNCTION partner_delivery_attempt_fence() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,public AS $$
BEGIN
 IF current_user='jrc_app' AND
  (NEW.organization_id,NEW.id,NEW.endpoint_id,NEW.event_id,NEW.replay_count,NEW.lifetime_attempts)
  IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.endpoint_id,OLD.event_id,OLD.replay_count,OLD.lifetime_attempts) THEN
  RAISE EXCEPTION 'PARTNER_DELIVERY_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 IF (current_user='jrc_app' AND OLD.status IN ('DELIVERED','CANCELLED') AND NEW.status<>OLD.status) THEN
  RAISE EXCEPTION 'PARTNER_DELIVERY_TERMINAL' USING ERRCODE='23514';
 END IF;
 IF NEW.attempts<OLD.attempts OR NEW.replay_count<>OLD.replay_count OR (OLD.status='FAILED' AND NEW.status<>'FAILED') THEN
  IF current_user<>'jrc_migrator' OR OLD.status<>'FAILED' OR OLD.lease_token IS NOT NULL OR OLD.lease_expires_at IS NOT NULL
   OR NEW.status<>'PENDING' OR NEW.attempts<>0 OR NEW.replay_count<>OLD.replay_count+1
   OR NOT EXISTS(SELECT 1 FROM public.partner_delivery_replays r
    WHERE r.organization_id=OLD.organization_id AND r.delivery_id=OLD.id AND r.endpoint_id=OLD.endpoint_id AND r.event_id=OLD.event_id
     AND r.replay_number=NEW.replay_count AND r.prior_attempts=OLD.attempts AND r.prior_error_code IS NOT DISTINCT FROM OLD.last_error_code) THEN
   RAISE EXCEPTION 'PARTNER_DELIVERY_INVALID_RESET' USING ERRCODE='23514';
  END IF;
 END IF;
 NEW.lifetime_attempts=OLD.lifetime_attempts+greatest(0,NEW.attempts-OLD.attempts);
 RETURN NEW;
END $$;
ALTER FUNCTION partner_delivery_attempt_fence() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION partner_delivery_attempt_fence() FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
CREATE TRIGGER partner_delivery_attempt_fence BEFORE UPDATE ON partner_event_deliveries
 FOR EACH ROW EXECUTE FUNCTION partner_delivery_attempt_fence();

-- Lock the key FOR UPDATE: concurrent control-binding FK insertion also waits.
-- No automatic scope expansion and no JWT/browser or control-bound credential.
CREATE FUNCTION partner_delivery_require_authority(authorizing_key uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=NULLIF(current_setting('app.organization_id',true),'')::uuid;
BEGIN
 IF org IS NULL OR NOT public.tenant_is_active(org) THEN
  RAISE EXCEPTION 'ORGANIZATION_NOT_ACTIVE' USING ERRCODE='23514',CONSTRAINT='tenant_organization_active';
 END IF;
 PERFORM k.id FROM public.api_keys k WHERE k.organization_id=org AND k.id=authorizing_key FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.api_keys k
  WHERE k.organization_id=org AND k.id=authorizing_key AND k.revoked_at IS NULL
   AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp()) AND k.scopes @> ARRAY['webhooks:manage']::text[]
   AND NOT EXISTS(SELECT 1 FROM public.chatwoot_control_bindings b WHERE b.organization_id=org AND b.api_key_id=k.id)) THEN
  RAISE EXCEPTION 'PARTNER_REPLAY_FORBIDDEN' USING ERRCODE='42501',CONSTRAINT='partner_replay_forbidden';
 END IF;
 RETURN org;
END $$;
ALTER FUNCTION partner_delivery_require_authority(uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION partner_delivery_require_authority(uuid) FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;

CREATE FUNCTION partner_replay_delivery(authorizing_key uuid,target_delivery uuid,intent uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public AS $$
DECLARE org uuid; target public.partner_event_deliveries%ROWTYPE; endpoint public.partner_webhook_endpoints%ROWTYPE;
 event_time timestamptz; previous public.partner_delivery_replays%ROWTYPE; accepted public.partner_delivery_replays%ROWTYPE;
 fingerprint text; replayed boolean:=false;
BEGIN
 org=public.partner_delivery_require_authority(authorizing_key);
 IF intent IS NULL OR target_delivery IS NULL THEN
  RAISE EXCEPTION 'PARTNER_REPLAY_CONFLICT' USING ERRCODE='23514',CONSTRAINT='partner_replay_conflict';
 END IF;
 fingerprint=encode(sha256(convert_to('partner-delivery-replay:v1:'||target_delivery::text||':{}','UTF8')),'hex');
 -- The key lock serializes (key,intent) including requests aimed at two different
 -- deliveries. An existing divergent intent must return 409 before a 404 lookup.
 SELECT * INTO previous FROM public.partner_delivery_replays
  WHERE organization_id=org AND authorizing_api_key_id=authorizing_key AND idempotency_key=intent;
 IF FOUND AND (previous.delivery_id<>target_delivery OR previous.request_hash<>fingerprint) THEN
  RAISE EXCEPTION 'PARTNER_REPLAY_CONFLICT' USING ERRCODE='23514',CONSTRAINT='partner_replay_conflict';
 END IF;
 SELECT * INTO target FROM public.partner_event_deliveries WHERE organization_id=org AND id=target_delivery;
 IF NOT FOUND THEN RAISE EXCEPTION 'PARTNER_DELIVERY_NOT_FOUND' USING ERRCODE='23514',CONSTRAINT='partner_delivery_not_found'; END IF;
 -- Consistent endpoint -> event -> delivery order. Revocation can commit first;
 -- a prune cannot delete this retained event while its replay is being recorded.
 SELECT * INTO endpoint FROM public.partner_webhook_endpoints WHERE organization_id=org AND id=target.endpoint_id FOR SHARE;
 IF NOT FOUND OR endpoint.status<>'ACTIVE' THEN RAISE EXCEPTION 'PARTNER_ENDPOINT_REVOKED' USING ERRCODE='23514',CONSTRAINT='partner_endpoint_revoked'; END IF;
 SELECT occurred_at INTO event_time FROM public.partner_events WHERE organization_id=org AND id=target.event_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PARTNER_EVENT_EXPIRED' USING ERRCODE='23514',CONSTRAINT='partner_event_expired'; END IF;
 SELECT * INTO target FROM public.partner_event_deliveries WHERE organization_id=org AND id=target_delivery FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PARTNER_DELIVERY_NOT_FOUND' USING ERRCODE='23514',CONSTRAINT='partner_delivery_not_found'; END IF;
 PERFORM public.partner_delivery_require_authority(authorizing_key);
 IF event_time<clock_timestamp()-interval '30 days' THEN
  RAISE EXCEPTION 'PARTNER_EVENT_EXPIRED' USING ERRCODE='23514',CONSTRAINT='partner_event_expired';
 END IF;
 IF previous.id IS NOT NULL THEN accepted=previous;replayed=true;
 ELSE
  IF target.status<>'FAILED' OR target.lease_token IS NOT NULL OR target.lease_expires_at IS NOT NULL THEN
   RAISE EXCEPTION 'PARTNER_DELIVERY_NOT_FAILED' USING ERRCODE='23514',CONSTRAINT='partner_delivery_not_failed';
  END IF;
  INSERT INTO public.partner_delivery_replays(organization_id,authorizing_api_key_id,idempotency_key,request_hash,delivery_id,endpoint_id,event_id,prior_attempts,prior_error_code,replay_number)
   VALUES(org,authorizing_key,intent,fingerprint,target.id,target.endpoint_id,target.event_id,target.attempts,target.last_error_code,target.replay_count+1) RETURNING * INTO accepted;
  UPDATE public.partner_event_deliveries SET status='PENDING',attempts=0,replay_count=replay_count+1,last_error_code=NULL,
   available_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL
   WHERE organization_id=org AND id=target_delivery;
 END IF;
 -- Recheck wall-clock expiry even if the ledger update crossed that boundary.
 PERFORM public.partner_delivery_require_authority(authorizing_key);
 RETURN jsonb_build_object('schemaVersion',1,'replayed',replayed,'replay',jsonb_build_object(
  'id',accepted.id,'deliveryId',accepted.delivery_id,'endpointId',accepted.endpoint_id,'eventId',accepted.event_id,
  'replayNumber',accepted.replay_number,'priorAttempts',accepted.prior_attempts,'acceptedAt',accepted.accepted_at));
END $$;
ALTER FUNCTION partner_replay_delivery(uuid,uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION partner_replay_delivery(uuid,uuid,uuid) FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
GRANT EXECUTE ON FUNCTION partner_replay_delivery(uuid,uuid,uuid) TO jrc_app;

CREATE FUNCTION partner_delivery_stats(authorizing_key uuid,target_endpoint uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public AS $$
DECLARE org uuid; result jsonb;
BEGIN
 org=public.partner_delivery_require_authority(authorizing_key);
 -- Only metadata from the logical 30-day retention window; bounded cardinality
 -- per delivery with no event payload, URL, encrypted secret or credential field.
 SELECT jsonb_build_object('schemaVersion',1,'retentionDays',30,'counts',jsonb_build_object(
  'PENDING',count(*) FILTER(WHERE d.status='PENDING'),'RUNNING',count(*) FILTER(WHERE d.status='RUNNING'),
  'DELIVERED',count(*) FILTER(WHERE d.status='DELIVERED'),'FAILED',count(*) FILTER(WHERE d.status='FAILED'),
  'CANCELLED',count(*) FILTER(WHERE d.status='CANCELLED')),
  'oldestPendingAt',min(d.available_at) FILTER(WHERE d.status='PENDING'),
  'expiredLeases',count(*) FILTER(WHERE d.status='RUNNING' AND d.lease_expires_at<=clock_timestamp()),
  'replays',coalesce(sum(d.replay_count),0),'lifetimeAttempts',coalesce(sum(d.lifetime_attempts),0)) INTO result
 FROM public.partner_event_deliveries d JOIN public.partner_events e ON e.organization_id=d.organization_id AND e.id=d.event_id
 WHERE d.organization_id=org AND (target_endpoint IS NULL OR d.endpoint_id=target_endpoint) AND e.occurred_at>=clock_timestamp()-interval '30 days';
 PERFORM public.partner_delivery_require_authority(authorizing_key);
 RETURN result;
END $$;
ALTER FUNCTION partner_delivery_stats(uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION partner_delivery_stats(uuid,uuid) FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
GRANT EXECUTE ON FUNCTION partner_delivery_stats(uuid,uuid) TO jrc_app;
-- Ledger deletion follows the existing cascading 30-day event prune and the
-- catalogue's guarded lifecycle purge; no new destructive retention collector.

CREATE FUNCTION audit_corrections_catalogue_ready() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public AS $$
 SELECT count(*)=2 FROM public.lifecycle_purge_catalogue
  WHERE table_name IN ('media_custody_receipts','partner_delivery_replays')
$$;
ALTER FUNCTION audit_corrections_catalogue_ready() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION audit_corrections_catalogue_ready() FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
GRANT EXECUTE ON FUNCTION audit_corrections_catalogue_ready() TO jrc_app;
