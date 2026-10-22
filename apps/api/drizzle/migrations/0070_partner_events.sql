-- Generic partner contract: independent of any receiving platform or remote account.
CREATE SEQUENCE partner_event_order_seq AS bigint;
CREATE TABLE partner_webhook_endpoints (
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 id uuid NOT NULL DEFAULT gen_random_uuid(), url text NOT NULL CHECK(length(url)<=2048),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','REVOKED')),
 encrypted_secret text, created_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz,
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,idempotency_key),
 CHECK((status='ACTIVE' AND encrypted_secret IS NOT NULL AND revoked_at IS NULL) OR
       (status='REVOKED' AND encrypted_secret IS NULL AND revoked_at IS NOT NULL))
);
CREATE TABLE partner_events (
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 id uuid NOT NULL DEFAULT gen_random_uuid(),sequence_number bigint,
 event_type text NOT NULL CHECK(event_type IN ('message.received','message.created','message.status','connection.status')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),payload jsonb NOT NULL,
 channel_id uuid,instance_id uuid,
 PRIMARY KEY(organization_id,id),UNIQUE(organization_id,sequence_number),
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,instance_id) REFERENCES instances(organization_id,id) ON DELETE CASCADE
);
CREATE TABLE partner_event_deliveries (
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),endpoint_id uuid NOT NULL,event_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RUNNING','DELIVERED','FAILED','CANCELLED')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10),
 available_at timestamptz NOT NULL DEFAULT now(),last_error_code text,updated_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid,lease_expires_at timestamptz,
 PRIMARY KEY(organization_id,id),UNIQUE(organization_id,endpoint_id,event_id),
 FOREIGN KEY(organization_id,endpoint_id) REFERENCES partner_webhook_endpoints(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,event_id) REFERENCES partner_events(organization_id,id) ON DELETE CASCADE,
 CHECK((status='RUNNING' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR (status<>'RUNNING' AND lease_token IS NULL AND lease_expires_at IS NULL))
);
CREATE TABLE partner_event_cursor_state (
 organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
 last_pruned_cursor bigint NOT NULL DEFAULT 0 CHECK(last_pruned_cursor>=0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partner_delivery_pending ON partner_event_deliveries(organization_id,available_at,id) WHERE status IN ('PENDING','RUNNING');
CREATE INDEX partner_events_unpublished ON partner_events(organization_id,occurred_at,id) WHERE sequence_number IS NULL;
CREATE INDEX partner_events_retention ON partner_events(organization_id,occurred_at,id);
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['partner_webhook_endpoints','partner_events','partner_event_deliveries','partner_event_cursor_state'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO jrc_migrator',tab);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY partner_tenant ON %I TO jrc_app USING(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',tab);
  EXECUTE format('CREATE POLICY lifecycle_migrator ON %I TO jrc_migrator USING(true) WITH CHECK(true)',tab);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle',tab);
 END LOOP;
END $$;
ALTER SEQUENCE partner_event_order_seq OWNER TO jrc_migrator;
REVOKE ALL ON SEQUENCE partner_event_order_seq FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
GRANT SELECT,INSERT ON partner_webhook_endpoints TO jrc_app;
GRANT UPDATE(status,encrypted_secret,revoked_at) ON partner_webhook_endpoints TO jrc_app;
GRANT SELECT ON partner_events TO jrc_app;
GRANT SELECT ON partner_event_cursor_state TO jrc_app;
GRANT SELECT,UPDATE(status,attempts,available_at,last_error_code,updated_at,lease_token,lease_expires_at) ON partner_event_deliveries TO jrc_app;

-- All event insertion is atomic with its source write. No polling gap or external I/O
-- inside the source transaction. Immutable event rows are not app-writable.
CREATE FUNCTION partner_capture_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public AS $$
DECLARE event_id uuid; kind text; body jsonb; event_channel uuid;event_instance uuid;
BEGIN
 -- Existing installations produce no partner copies until a tenant opts in by
 -- issuing a partner API scope or registering an endpoint.
 IF NOT EXISTS(SELECT 1 FROM public.partner_webhook_endpoints WHERE organization_id=NEW.organization_id AND status='ACTIVE')
 AND NOT EXISTS(SELECT 1 FROM public.api_keys WHERE organization_id=NEW.organization_id AND revoked_at IS NULL
  AND (expires_at IS NULL OR expires_at>now()) AND scopes && ARRAY['messaging:read','messaging:send','webhooks:manage']::text[]) THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='messaging_messages' THEN
  -- History import is deliberately non-actionable; importing an old message must
  -- never look like a fresh incoming webhook that a receiver might auto-answer.
  IF NEW.is_historical THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NEW; END IF;
  kind:=CASE WHEN TG_OP='UPDATE' THEN 'message.status' WHEN NEW.direction='INCOMING' THEN 'message.received' ELSE 'message.created' END;
  event_channel:=NEW.channel_id;
  body:=jsonb_build_object('messageId',NEW.id,'channelId',NEW.channel_id,'conversationId',NEW.conversation_id,
   'direction',NEW.direction,'source',NEW.source,'state',NEW.state,'upstreamMessageId',NEW.upstream_message_id,
   'content',NEW.content,'errorCode',NEW.canonical_error_code,
   'contact', (SELECT jsonb_build_object('id',c.id,'externalId',c.external_id,'displayName',c.display_name)
    FROM public.messaging_conversations cv JOIN public.messaging_contacts c ON c.organization_id=cv.organization_id AND c.id=cv.contact_id
    WHERE cv.organization_id=NEW.organization_id AND cv.id=NEW.conversation_id));
 ELSE
  IF TG_OP='UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  kind:='connection.status';
  IF TG_TABLE_NAME='meta_connections' THEN
   event_channel:=NEW.channel_id;
   body:=jsonb_build_object('connectionId',NEW.id,'channelId',NEW.channel_id,'provider','META','status',NEW.status);
  ELSE
   event_instance:=NEW.id;
   body:=jsonb_build_object('instanceId',NEW.id,'provider','BAILEYS','status',NEW.status);
  END IF;
 END IF;
 INSERT INTO public.partner_events(organization_id,event_type,payload,channel_id,instance_id) VALUES(NEW.organization_id,kind,body,event_channel,event_instance) RETURNING id INTO event_id;
 INSERT INTO public.partner_event_deliveries(organization_id,endpoint_id,event_id)
  SELECT NEW.organization_id,id,event_id FROM public.partner_webhook_endpoints WHERE organization_id=NEW.organization_id AND status='ACTIVE';
 RETURN NEW;
END $$;
ALTER FUNCTION partner_capture_event() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION partner_capture_event() FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
CREATE TRIGGER partner_message_event AFTER INSERT OR UPDATE OF state ON messaging_messages FOR EACH ROW EXECUTE FUNCTION partner_capture_event();
CREATE TRIGGER partner_connection_event AFTER INSERT OR UPDATE OF status ON instances FOR EACH ROW EXECUTE FUNCTION partner_capture_event();
CREATE TRIGGER partner_meta_connection_event AFTER INSERT OR UPDATE OF status ON meta_connections FOR EACH ROW EXECUTE FUNCTION partner_capture_event();

-- Cursor allocation is deferred until a separate transaction observes committed
-- events. This avoids holding an org advisory lock while source rows are locked,
-- and prevents consumers skipping a source transaction that commits late.
CREATE FUNCTION partner_publish_events() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=NULLIF(current_setting('app.organization_id',true),'')::uuid; item record; published integer:=0;
BEGIN
 IF org IS NULL THEN RETURN 0; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('partner-events:'||org::text,0));
 INSERT INTO public.partner_event_cursor_state(organization_id) VALUES(org) ON CONFLICT(organization_id) DO NOTHING;
 -- Retention is logically immediate even when physical deletion needs several
 -- bounded passes. Mark every expired published cursor before selecting victims.
 UPDATE public.partner_event_cursor_state SET last_pruned_cursor=greatest(last_pruned_cursor,
  coalesce((SELECT max(sequence_number) FROM public.partner_events WHERE organization_id=org AND occurred_at<now()-interval '30 days'),0))
 WHERE organization_id=org;
 -- A source transaction may have observed ACTIVE before a concurrent revocation
 -- committed. Cancel that late fanout as well; it must not remain a poison queue.
 UPDATE public.partner_event_deliveries SET status='CANCELLED',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
 WHERE organization_id=org AND id IN (
  SELECT d.id FROM public.partner_event_deliveries d JOIN public.partner_webhook_endpoints p
   ON p.organization_id=d.organization_id AND p.id=d.endpoint_id
  WHERE d.organization_id=org AND d.status IN ('PENDING','RUNNING') AND p.status='REVOKED' LIMIT 500);
 WITH deleted AS (DELETE FROM public.partner_events WHERE organization_id=org AND id IN (
  SELECT e.id FROM public.partner_events e WHERE e.organization_id=org AND e.occurred_at<now()-interval '30 days'
   AND NOT EXISTS(SELECT 1 FROM public.partner_event_deliveries d WHERE d.organization_id=org AND d.event_id=e.id AND d.status='RUNNING' AND d.lease_expires_at>now())
  ORDER BY e.occurred_at,e.id LIMIT 500) RETURNING sequence_number)
 UPDATE public.partner_event_cursor_state SET last_pruned_cursor=greatest(last_pruned_cursor,coalesce((SELECT max(sequence_number) FROM deleted),0)),updated_at=now() WHERE organization_id=org;
 IF NOT EXISTS(SELECT 1 FROM public.organizations WHERE id=org AND status='ACTIVE') THEN RETURN 0; END IF;
 FOR item IN SELECT id FROM public.partner_events WHERE organization_id=org AND sequence_number IS NULL AND occurred_at>=now()-interval '30 days' ORDER BY occurred_at,id LIMIT 1000 FOR UPDATE LOOP
  UPDATE public.partner_events SET sequence_number=nextval('public.partner_event_order_seq') WHERE organization_id=org AND id=item.id;
  published:=published+1;
 END LOOP;
 RETURN published;
END $$;
ALTER FUNCTION partner_publish_events() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION partner_publish_events() FROM PUBLIC,jrc_auth,jrc_platform,jrc_lifecycle;
GRANT EXECUTE ON FUNCTION partner_publish_events() TO jrc_app;

CREATE FUNCTION partner_event_worker_organizations(after_id uuid, batch_limit integer) RETURNS TABLE(organization_id uuid)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT candidates.organization_id FROM (
  SELECT d.organization_id FROM public.partner_event_deliveries d JOIN public.organizations o ON o.id=d.organization_id
   WHERE o.status='ACTIVE' AND ((d.status='PENDING' AND d.available_at<=now()) OR (d.status='RUNNING' AND d.lease_expires_at<=now()))
  UNION
  SELECT e.organization_id FROM public.partner_events e JOIN public.organizations o ON o.id=e.organization_id
   WHERE (e.sequence_number IS NULL AND o.status='ACTIVE') OR (e.occurred_at<now()-interval '30 days' AND NOT EXISTS(
    SELECT 1 FROM public.partner_event_deliveries d WHERE d.organization_id=e.organization_id AND d.event_id=e.id AND d.status='RUNNING' AND d.lease_expires_at>now()))
 ) candidates WHERE after_id IS NULL OR candidates.organization_id>after_id
 ORDER BY candidates.organization_id LIMIT greatest(1,least(coalesce(batch_limit,100),100))
$$;
ALTER FUNCTION partner_event_worker_organizations(uuid,integer) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION partner_event_worker_organizations(uuid,integer) FROM PUBLIC,jrc_auth,jrc_platform,jrc_lifecycle;
GRANT EXECUTE ON FUNCTION partner_event_worker_organizations(uuid,integer) TO jrc_app;
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('partner_webhook_endpoints'),('partner_events'),('partner_event_deliveries'),('partner_event_cursor_state');
CREATE FUNCTION partner_event_catalogue_ready() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public AS $$
 SELECT count(*)=4 FROM public.lifecycle_purge_catalogue WHERE table_name IN
 ('partner_webhook_endpoints','partner_events','partner_event_deliveries','partner_event_cursor_state')
$$;
ALTER FUNCTION partner_event_catalogue_ready() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION partner_event_catalogue_ready() FROM PUBLIC,jrc_auth,jrc_platform,jrc_lifecycle;
GRANT EXECUTE ON FUNCTION partner_event_catalogue_ready() TO jrc_app;
