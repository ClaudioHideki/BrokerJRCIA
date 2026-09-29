-- Destructive work is restricted to a persisted, authorized operation. Runtime roles receive no general DELETE grants.
CREATE TABLE lifecycle_deletions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('CHANNEL','ORGANIZATION')),
 resource_id uuid NOT NULL,
 resource_name text,
 messaging_channel_id uuid,
 provider text CHECK(provider IN ('QR','META')),
 upstream_key text,
 actor_kind text NOT NULL CHECK(actor_kind IN ('TENANT','PLATFORM')),
 actor_id uuid NOT NULL,
 reason text CHECK(reason IS NULL OR length(btrim(reason)) BETWEEN 5 AND 500),
 status text NOT NULL DEFAULT 'REQUESTED' CHECK(status IN ('REQUESTED','BLOCKING','CLEANING_EXTERNAL','REMOVING_DATA','COMPLETED','ACTION_REQUIRED')),
 error_code text,
 lease_token uuid,
 lease_expires_at timestamptz,
 requested_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 UNIQUE(kind,resource_id),
 CHECK((kind='CHANNEL' AND provider IS NOT NULL) OR (kind='ORGANIZATION' AND provider IS NULL)),
 CHECK((lease_token IS NULL)=(lease_expires_at IS NULL))
);
CREATE INDEX lifecycle_deletions_work ON lifecycle_deletions(status,updated_at) WHERE status<>'COMPLETED';
CREATE TABLE lifecycle_cleanup_items (
 deletion_id uuid NOT NULL REFERENCES lifecycle_deletions(id) ON DELETE CASCADE,
 instance_id uuid NOT NULL,
 upstream_key text NOT NULL,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','DONE','ACTION_REQUIRED')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 last_error_code text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(deletion_id,instance_id)
);
CREATE TABLE lifecycle_purge_catalogue (table_name text PRIMARY KEY CHECK(table_name ~ '^[a-z][a-z0-9_]{0,62}$'));
INSERT INTO lifecycle_purge_catalogue(table_name)
 SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
 WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT IN ('lifecycle_deletions','lifecycle_cleanup_items');
ALTER TABLE lifecycle_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle_deletions FORCE ROW LEVEL SECURITY;
ALTER TABLE lifecycle_cleanup_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle_cleanup_items FORCE ROW LEVEL SECURITY;
ALTER TABLE lifecycle_purge_catalogue ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle_purge_catalogue FORCE ROW LEVEL SECURITY;
CREATE POLICY lifecycle_platform ON lifecycle_deletions FOR SELECT TO jrc_platform USING(true);
CREATE POLICY lifecycle_worker ON lifecycle_deletions TO jrc_lifecycle USING(true) WITH CHECK(true);
CREATE POLICY lifecycle_migrator ON lifecycle_deletions TO jrc_migrator USING(true) WITH CHECK(true);
CREATE POLICY lifecycle_cleanup_worker ON lifecycle_cleanup_items TO jrc_lifecycle USING(true) WITH CHECK(true);
CREATE POLICY lifecycle_cleanup_migrator ON lifecycle_cleanup_items TO jrc_migrator USING(true) WITH CHECK(true);
CREATE POLICY lifecycle_catalogue_migrator ON lifecycle_purge_catalogue TO jrc_migrator USING(true) WITH CHECK(true);
GRANT SELECT ON lifecycle_deletions TO jrc_platform;
GRANT SELECT,UPDATE(status,error_code,lease_token,lease_expires_at,updated_at) ON lifecycle_deletions TO jrc_lifecycle;
GRANT SELECT,UPDATE(status,attempts,last_error_code,updated_at) ON lifecycle_cleanup_items TO jrc_lifecycle;
-- The API role cannot insert or alter a persisted purge authorization. Only the isolated worker can advance one.
DO $$ DECLARE t text; BEGIN
 FOR t IN SELECT table_name FROM lifecycle_purge_catalogue LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='lifecycle_migrator') THEN
   EXECUTE format('CREATE POLICY lifecycle_migrator ON public.%I TO jrc_migrator USING(true) WITH CHECK(true)',t);
  END IF;
 END LOOP;
END $$;
CREATE POLICY lifecycle_platform_users_migrator ON platform_users FOR SELECT TO jrc_migrator USING(true);
CREATE POLICY lifecycle_users_migrator ON users TO jrc_migrator USING(true) WITH CHECK(true);
CREATE POLICY lifecycle_login_sessions_migrator ON login_sessions TO jrc_migrator USING(true) WITH CHECK(true);
CREATE POLICY lifecycle_platform_users_worker ON platform_users FOR SELECT TO jrc_lifecycle USING(true);
CREATE POLICY lifecycle_users_worker ON users FOR SELECT TO jrc_lifecycle USING(true);
CREATE POLICY lifecycle_memberships_worker ON memberships FOR SELECT TO jrc_lifecycle USING(true);
GRANT SELECT(id,role,active) ON platform_users TO jrc_lifecycle;
GRANT SELECT(id,status) ON users TO jrc_lifecycle;
GRANT SELECT(organization_id,user_id,status,role) ON memberships TO jrc_lifecycle;
GRANT USAGE ON TYPE user_status,membership_status,membership_role TO jrc_lifecycle;
-- Revoke default PUBLIC execution for all destructive functions individually after creation.
ALTER TABLE messaging_channels ADD COLUMN deleting_at timestamptz;
CREATE FUNCTION lifecycle_reject_restore() RETURNS trigger LANGUAGE plpgsql
 SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='instances' THEN
  IF (NEW.archived_at IS NULL AND OLD.archived_at IS NOT NULL OR NEW.name IS DISTINCT FROM OLD.name)
    AND EXISTS(SELECT 1 FROM public.lifecycle_deletions d WHERE d.organization_id=OLD.organization_id
      AND d.kind='CHANNEL' AND d.resource_id=OLD.id AND d.status<>'COMPLETED') THEN
   RAISE EXCEPTION 'CHANNEL_DELETION_IN_PROGRESS' USING ERRCODE='23514',CONSTRAINT='channel_deletion_in_progress';
  END IF;
 END IF;
 IF TG_TABLE_NAME='meta_connections' THEN
  IF NEW.status='READY' AND OLD.status IS DISTINCT FROM 'READY'
    AND EXISTS(SELECT 1 FROM public.lifecycle_deletions d WHERE d.organization_id=OLD.organization_id
      AND d.kind='CHANNEL' AND d.resource_id=OLD.id AND d.status<>'COMPLETED') THEN
   RAISE EXCEPTION 'CHANNEL_DELETION_IN_PROGRESS' USING ERRCODE='23514',CONSTRAINT='channel_deletion_in_progress';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lifecycle_reject_restore() FROM PUBLIC;
CREATE TRIGGER lifecycle_instance_restore_block BEFORE UPDATE OF archived_at,name ON instances
 FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_restore();
CREATE TRIGGER lifecycle_meta_restore_block BEFORE UPDATE OF status ON meta_connections
 FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_restore();
CREATE FUNCTION lifecycle_reject_organization_restore() RETURNS trigger LANGUAGE plpgsql
 SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.status<>'DISABLED' AND EXISTS(SELECT 1 FROM public.lifecycle_deletions d
   WHERE d.organization_id=OLD.id AND d.kind='ORGANIZATION' AND d.status<>'COMPLETED') THEN
  RAISE EXCEPTION 'ORGANIZATION_DELETION_IN_PROGRESS' USING ERRCODE='23514',CONSTRAINT='organization_deletion_in_progress';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lifecycle_reject_organization_restore() FROM PUBLIC;
CREATE TRIGGER lifecycle_organization_restore_block BEFORE UPDATE OF status ON organizations
 FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_organization_restore();
CREATE FUNCTION lifecycle_reject_channel_write() RETURNS trigger LANGUAGE plpgsql
 SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE deleting timestamptz;
BEGIN
 -- Subscription suspension must still accept incoming messages and receipts. Only
 -- a durable deletion request closes ingestion; the row lock serializes the fence.
 PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR SHARE;
 IF EXISTS (SELECT 1 FROM public.lifecycle_deletions d WHERE d.organization_id=NEW.organization_id
   AND d.kind='ORGANIZATION' AND d.status<>'COMPLETED') THEN
  RAISE EXCEPTION 'ORGANIZATION_DELETION_IN_PROGRESS' USING ERRCODE='23514',CONSTRAINT='organization_deletion_in_progress';
 END IF;
 SELECT deleting_at INTO deleting FROM public.messaging_channels
  WHERE organization_id=NEW.organization_id AND id=NEW.channel_id FOR SHARE;
 IF deleting IS NOT NULL THEN
  RAISE EXCEPTION 'CHANNEL_DELETION_IN_PROGRESS' USING ERRCODE='23514',CONSTRAINT='channel_deletion_in_progress';
 END IF;
 IF EXISTS (SELECT 1 FROM public.lifecycle_deletions d WHERE d.organization_id=NEW.organization_id
   AND d.messaging_channel_id=NEW.channel_id AND d.kind='CHANNEL' AND d.status<>'COMPLETED') THEN
  RAISE EXCEPTION 'CHANNEL_DELETION_IN_PROGRESS' USING ERRCODE='23514',CONSTRAINT='channel_deletion_in_progress';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lifecycle_reject_channel_write() FROM PUBLIC;
CREATE TRIGGER lifecycle_messages_block BEFORE INSERT ON messaging_messages FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_channel_write();
CREATE TRIGGER lifecycle_inbox_block BEFORE INSERT ON messaging_inbox_events FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_channel_write();
CREATE TRIGGER lifecycle_status_block BEFORE INSERT ON messaging_status_events FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_channel_write();
CREATE TRIGGER lifecycle_media_block BEFORE INSERT ON messaging_media FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_channel_write();
CREATE TRIGGER lifecycle_automation_block BEFORE INSERT ON automation_executions FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_channel_write();
CREATE TRIGGER lifecycle_binding_block BEFORE INSERT ON automation_bindings FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_channel_write();
CREATE FUNCTION lifecycle_reject_external_start() RETURNS trigger LANGUAGE plpgsql
 SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM public.lifecycle_deletions d WHERE d.organization_id=NEW.organization_id
   AND d.kind='ORGANIZATION' AND d.status<>'COMPLETED') THEN
  IF TG_TABLE_NAME='chatwoot_provisioning' THEN
   IF NEW.state IN ('PENDING','RUNNING','UNKNOWN') THEN
    RAISE EXCEPTION 'ORGANIZATION_DELETION_IN_PROGRESS' USING ERRCODE='23514',CONSTRAINT='organization_deletion_in_progress';
   END IF;
  ELSIF TG_TABLE_NAME='chatwoot_embed_apps' THEN
   IF NEW.install_lease IS NOT NULL OR NEW.install_state='UNKNOWN' THEN
    RAISE EXCEPTION 'ORGANIZATION_DELETION_IN_PROGRESS' USING ERRCODE='23514',CONSTRAINT='organization_deletion_in_progress';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lifecycle_reject_external_start() FROM PUBLIC;
CREATE TRIGGER lifecycle_provisioning_start_block BEFORE INSERT OR UPDATE OF state,lease_token ON chatwoot_provisioning
 FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_external_start();
CREATE TRIGGER lifecycle_embed_start_block BEFORE INSERT OR UPDATE OF install_state,install_lease ON chatwoot_embed_apps
 FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_external_start();
-- The callback resolver must stop routing assets as soon as local permission is revoked.
CREATE OR REPLACE FUNCTION resolve_meta_asset(phone text,waba text)
RETURNS TABLE(organization_id uuid,channel_id uuid) LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
 SELECT m.organization_id,m.channel_id FROM public.meta_connections m
 WHERE m.phone_number_id=phone AND m.waba_id=waba
   AND NOT EXISTS (SELECT 1 FROM public.lifecycle_deletions d WHERE d.organization_id=m.organization_id
    AND d.resource_id=m.id AND d.kind='CHANNEL' AND d.status<>'COMPLETED')
   AND NOT EXISTS (SELECT 1 FROM public.lifecycle_deletions d WHERE d.organization_id=m.organization_id
    AND d.kind='ORGANIZATION' AND d.status<>'COMPLETED')
$$;
ALTER FUNCTION resolve_meta_asset(text,text) OWNER TO jrc_migrator;
CREATE OR REPLACE FUNCTION resolve_meta_waba(waba text)
RETURNS TABLE(organization_id uuid,id uuid) LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
 SELECT m.organization_id,m.id FROM public.meta_connections m
 WHERE m.waba_id=waba AND m.status<>'REVOKED'
   AND NOT EXISTS (SELECT 1 FROM public.lifecycle_deletions d WHERE d.organization_id=m.organization_id
    AND d.resource_id=m.id AND d.kind='CHANNEL' AND d.status<>'COMPLETED')
   AND NOT EXISTS (SELECT 1 FROM public.lifecycle_deletions d WHERE d.organization_id=m.organization_id
    AND d.kind='ORGANIZATION' AND d.status<>'COMPLETED')
$$;
ALTER FUNCTION resolve_meta_waba(text) OWNER TO jrc_migrator;
CREATE OR REPLACE FUNCTION resolve_qr_channel(p_channel uuid)
RETURNS TABLE(organization_id uuid,instance_id uuid) LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
 SELECT c.organization_id,c.instance_id FROM public.messaging_channels c
 JOIN public.instances i ON i.organization_id=c.organization_id AND i.id=c.instance_id
 JOIN public.organizations o ON o.id=c.organization_id
 WHERE c.id=p_channel AND c.provider='BAILEYS' AND c.deleting_at IS NULL
   AND i.archived_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.lifecycle_deletions d WHERE d.organization_id=o.id
     AND d.kind='ORGANIZATION' AND d.status<>'COMPLETED')
$$;
ALTER FUNCTION resolve_qr_channel(uuid) OWNER TO jrc_migrator;

CREATE FUNCTION lifecycle_cancel_safe_work(p_org uuid,p_channel uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF session_user<>'jrc_platform' THEN RAISE EXCEPTION 'LIFECYCLE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 -- Serialize with workers that claim existing rows using SKIP LOCKED/row updates.
 PERFORM 1 FROM public.messaging_outbox o JOIN public.messaging_messages m
  ON m.organization_id=o.organization_id AND m.id=o.message_id
  WHERE o.organization_id=p_org AND (p_channel IS NULL OR m.channel_id=p_channel)
  ORDER BY o.message_id FOR UPDATE OF o,m;
 PERFORM 1 FROM public.integration_jobs j JOIN public.chatwoot_connections c
  ON c.organization_id=j.organization_id AND c.id=j.integration_id
  WHERE j.organization_id=p_org AND (p_channel IS NULL OR c.channel_id=p_channel)
  ORDER BY j.id FOR UPDATE OF j;
 PERFORM 1 FROM public.automation_executions WHERE organization_id=p_org
  AND (p_channel IS NULL OR channel_id=p_channel) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.automation_outbox o JOIN public.automation_executions e
  ON e.organization_id=o.organization_id AND e.id=o.execution_id
  WHERE o.organization_id=p_org AND (p_channel IS NULL OR e.channel_id=p_channel)
  ORDER BY o.id FOR UPDATE OF o;
 -- Flow callbacks/execution lock the binding before touching events and outputs.
 PERFORM 1 FROM public.flow_chatwoot_bindings b
   LEFT JOIN public.chatwoot_connections c ON c.organization_id=b.organization_id AND c.inbox_id=b.inbox_id
   WHERE b.organization_id=p_org AND (p_channel IS NULL OR c.channel_id=p_channel)
   ORDER BY b.id FOR UPDATE OF b;
 PERFORM 1 FROM public.flow_chatwoot_outbox o JOIN public.flow_chatwoot_bindings b
   ON b.organization_id=o.organization_id AND b.id=o.binding_id
   LEFT JOIN public.chatwoot_connections c ON c.organization_id=b.organization_id AND c.inbox_id=b.inbox_id
   WHERE o.organization_id=p_org AND (p_channel IS NULL OR c.channel_id=p_channel)
   ORDER BY o.id FOR UPDATE OF o;
 PERFORM 1 FROM public.flow_chatwoot_events e JOIN public.flow_chatwoot_bindings b
   ON b.organization_id=e.organization_id AND b.id=e.binding_id
   LEFT JOIN public.chatwoot_connections c ON c.organization_id=b.organization_id AND c.inbox_id=b.inbox_id
   WHERE e.organization_id=p_org AND (p_channel IS NULL OR c.channel_id=p_channel)
   ORDER BY e.id FOR UPDATE OF e;
 PERFORM 1 FROM public.messaging_bot_jobs j JOIN public.messaging_conversations v
   ON v.organization_id=j.organization_id AND v.id=j.conversation_id
   WHERE j.organization_id=p_org AND (p_channel IS NULL OR v.channel_id=p_channel)
   ORDER BY j.message_id FOR UPDATE OF j;
 PERFORM 1 FROM public.messaging_media m WHERE m.organization_id=p_org
   AND (p_channel IS NULL OR m.channel_id=p_channel) ORDER BY m.id FOR UPDATE;
 -- Never erase a claimed delivery or an uncertain provider result: a human must reconcile it.
 IF EXISTS(SELECT 1 FROM public.messaging_outbox o JOIN public.messaging_messages m
   ON m.organization_id=o.organization_id AND m.id=o.message_id
   WHERE o.organization_id=p_org AND (p_channel IS NULL OR m.channel_id=p_channel) AND o.lease_token IS NOT NULL)
   OR EXISTS(SELECT 1 FROM public.messaging_messages WHERE organization_id=p_org
     AND (p_channel IS NULL OR channel_id=p_channel) AND direction='OUTGOING' AND state IN ('SENDING','UNKNOWN'))
   OR EXISTS(SELECT 1 FROM public.integration_jobs j JOIN public.chatwoot_connections c
     ON c.organization_id=j.organization_id AND c.id=j.integration_id
     WHERE j.organization_id=p_org AND (p_channel IS NULL OR c.channel_id=p_channel)
       AND (j.status IN ('RUNNING','UNKNOWN') OR j.lease_token IS NOT NULL))
   OR EXISTS(SELECT 1 FROM public.automation_executions e WHERE e.organization_id=p_org
     AND (p_channel IS NULL OR e.channel_id=p_channel) AND (e.status IN ('RUNNING','UNKNOWN') OR e.lease_token IS NOT NULL))
   OR EXISTS(SELECT 1 FROM public.automation_outbox o JOIN public.automation_executions e
     ON e.organization_id=o.organization_id AND e.id=o.execution_id WHERE o.organization_id=p_org
       AND (p_channel IS NULL OR e.channel_id=p_channel) AND (o.status IN ('SENDING','UNKNOWN') OR o.lease_token IS NOT NULL))
   OR EXISTS(SELECT 1 FROM public.flow_chatwoot_outbox o JOIN public.flow_chatwoot_bindings b
     ON b.organization_id=o.organization_id AND b.id=o.binding_id
     LEFT JOIN public.chatwoot_connections c ON c.organization_id=b.organization_id AND c.inbox_id=b.inbox_id
     WHERE o.organization_id=p_org AND (p_channel IS NULL OR c.channel_id=p_channel)
       AND (o.status IN ('SENDING','UNKNOWN') OR o.lease_expires_at IS NOT NULL))
   OR EXISTS(SELECT 1 FROM public.messaging_bot_jobs j JOIN public.messaging_conversations v
     ON v.organization_id=j.organization_id AND v.id=j.conversation_id
     WHERE j.organization_id=p_org AND (p_channel IS NULL OR v.channel_id=p_channel)
       AND (j.status IN ('RUNNING','UNKNOWN') OR j.lease_token IS NOT NULL))
   OR EXISTS(SELECT 1 FROM public.messaging_media WHERE organization_id=p_org
     AND (p_channel IS NULL OR channel_id=p_channel) AND lease_token IS NOT NULL)
 THEN RAISE EXCEPTION 'LIFECYCLE_PENDING_WORK' USING ERRCODE='23514',CONSTRAINT='lifecycle_pending_work'; END IF;
 -- Claims use row locks; these mutations serialize against claims before the fence is committed.
 DELETE FROM public.messaging_outbox o USING public.messaging_messages m
  WHERE o.organization_id=p_org AND o.organization_id=m.organization_id AND o.message_id=m.id
    AND (p_channel IS NULL OR m.channel_id=p_channel) AND m.state='ACCEPTED' AND o.lease_token IS NULL;
 UPDATE public.messaging_messages SET state='FAILED',canonical_error_code='RESOURCE_DELETING',updated_at=now()
  WHERE organization_id=p_org AND (p_channel IS NULL OR channel_id=p_channel)
    AND direction='OUTGOING' AND state='ACCEPTED';
 UPDATE public.integration_jobs j SET status='FAILED',last_error='RESOURCE_DELETING',updated_at=now()
  FROM public.chatwoot_connections c WHERE j.organization_id=p_org AND j.organization_id=c.organization_id
    AND j.integration_id=c.id AND (p_channel IS NULL OR c.channel_id=p_channel) AND j.status='PENDING';
 UPDATE public.automation_outbox o SET status='CANCELED',updated_at=now()
  FROM public.automation_executions e WHERE o.organization_id=p_org AND o.organization_id=e.organization_id
    AND o.execution_id=e.id AND (p_channel IS NULL OR e.channel_id=p_channel) AND o.status='PENDING';
 UPDATE public.automation_waits w SET status='CANCELED',resumed_at=now()
  FROM public.automation_executions e WHERE w.organization_id=p_org AND w.organization_id=e.organization_id
    AND w.execution_id=e.id AND (p_channel IS NULL OR e.channel_id=p_channel) AND w.status='WAITING';
 UPDATE public.automation_executions SET status='CANCELED',completed_at=now(),updated_at=now(),error_code='RESOURCE_DELETING'
  WHERE organization_id=p_org AND (p_channel IS NULL OR channel_id=p_channel) AND status IN ('QUEUED','WAITING');
 UPDATE public.flow_chatwoot_outbox o SET status='CANCELED',last_error='RESOURCE_DELETING'
  FROM public.flow_chatwoot_bindings b LEFT JOIN public.chatwoot_connections c
    ON c.organization_id=b.organization_id AND c.inbox_id=b.inbox_id
  WHERE o.organization_id=p_org AND o.organization_id=b.organization_id AND o.binding_id=b.id
    AND (p_channel IS NULL OR c.channel_id=p_channel) AND o.status='PENDING';
 UPDATE public.flow_chatwoot_events e SET status='PAUSED',last_error='RESOURCE_DELETING'
  FROM public.flow_chatwoot_bindings b LEFT JOIN public.chatwoot_connections c
    ON c.organization_id=b.organization_id AND c.inbox_id=b.inbox_id
  WHERE e.organization_id=p_org AND e.organization_id=b.organization_id AND e.binding_id=b.id
    AND (p_channel IS NULL OR c.channel_id=p_channel) AND e.status='PENDING';
 UPDATE public.messaging_bot_jobs j SET status='FAILED',canonical_error_code='RESOURCE_DELETING',updated_at=now()
  FROM public.messaging_conversations v WHERE j.organization_id=p_org AND j.organization_id=v.organization_id
    AND j.conversation_id=v.id AND (p_channel IS NULL OR v.channel_id=p_channel) AND j.status='PENDING';
 UPDATE public.messaging_media SET status='FAILED',last_error='RESOURCE_DELETING',updated_at=now()
  WHERE organization_id=p_org AND (p_channel IS NULL OR channel_id=p_channel) AND status='PENDING';
END $$;
ALTER FUNCTION lifecycle_cancel_safe_work(uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_cancel_safe_work(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION lifecycle_request_channel(p_org uuid,p_resource uuid,p_name text,p_reason text,p_actor_kind text,p_actor uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target record; existing public.lifecycle_deletions%ROWTYPE; operation_id uuid;
BEGIN
 IF session_user<>'jrc_platform' OR length(btrim(p_reason)) NOT BETWEEN 5 AND 500 THEN
  RAISE EXCEPTION 'LIFECYCLE_FORBIDDEN' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('lifecycle:'||p_org::text,0));
 IF EXISTS(SELECT 1 FROM public.lifecycle_deletions WHERE kind='ORGANIZATION'
   AND resource_id=p_org AND status<>'COMPLETED') THEN
  RAISE EXCEPTION 'ORGANIZATION_DELETION_IN_PROGRESS' USING ERRCODE='23514',CONSTRAINT='lifecycle_conflict';
 END IF;
 IF p_actor_kind='TENANT' THEN
  IF NOT EXISTS (SELECT 1 FROM public.memberships m JOIN public.users u ON u.id=m.user_id
    WHERE m.organization_id=p_org AND m.user_id=p_actor AND m.status='ACTIVE' AND u.status='ACTIVE'
      AND m.role IN ('OWNER','ADMIN')) THEN
   RAISE EXCEPTION 'LIFECYCLE_FORBIDDEN' USING ERRCODE='42501';
  END IF;
 ELSIF p_actor_kind='PLATFORM' THEN
  IF NOT EXISTS (SELECT 1 FROM public.platform_users u WHERE u.id=p_actor AND u.role='SUPER_ADMIN' AND u.active) THEN
   RAISE EXCEPTION 'LIFECYCLE_FORBIDDEN' USING ERRCODE='42501';
  END IF;
 ELSE RAISE EXCEPTION 'LIFECYCLE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT * INTO existing FROM public.lifecycle_deletions WHERE kind='CHANNEL' AND resource_id=p_resource FOR UPDATE;
 IF FOUND THEN
  IF existing.organization_id<>p_org OR existing.resource_name IS DISTINCT FROM p_name THEN
   RAISE EXCEPTION 'CHANNEL_NOT_FOUND' USING ERRCODE='P0002';
  END IF;
  IF existing.status='ACTION_REQUIRED' THEN
   UPDATE public.lifecycle_deletions SET status='REQUESTED',error_code=NULL,lease_token=NULL,lease_expires_at=NULL,
     actor_kind=p_actor_kind,actor_id=p_actor,reason=p_reason,updated_at=now()
    WHERE id=existing.id;
  END IF;
  RETURN existing.id;
 END IF;
 SELECT i.id,i.name,i.upstream_instance_key,mc.id AS messaging_channel_id,'QR'::text AS provider
  INTO target FROM public.instances i LEFT JOIN public.messaging_channels mc
   ON mc.organization_id=i.organization_id AND mc.instance_id=i.id
  WHERE i.organization_id=p_org AND i.id=p_resource FOR UPDATE OF i;
 IF NOT FOUND THEN
  SELECT m.id,'WhatsApp oficial'::text AS name,NULL::text AS upstream_instance_key,m.channel_id AS messaging_channel_id,
    'META'::text AS provider INTO target
   FROM public.meta_connections m WHERE m.organization_id=p_org AND m.id=p_resource FOR UPDATE;
 END IF;
 IF NOT FOUND OR target.name IS DISTINCT FROM p_name THEN
  RAISE EXCEPTION 'CHANNEL_NOT_FOUND_OR_NAME_MISMATCH' USING ERRCODE='P0002';
 END IF;
 IF target.messaging_channel_id IS NOT NULL AND (
   EXISTS(SELECT 1 FROM public.messaging_messages WHERE organization_id=p_org AND channel_id=target.messaging_channel_id
    AND direction='OUTGOING' AND state IN ('SENDING','UNKNOWN'))
   OR EXISTS(SELECT 1 FROM public.integration_jobs j JOIN public.chatwoot_connections c
    ON c.organization_id=j.organization_id AND c.id=j.integration_id
    WHERE c.organization_id=p_org AND c.channel_id=target.messaging_channel_id
      AND j.status IN ('RUNNING','UNKNOWN'))
   OR EXISTS(SELECT 1 FROM public.automation_executions WHERE organization_id=p_org AND channel_id=target.messaging_channel_id
    AND status IN ('RUNNING','UNKNOWN'))
 ) THEN RAISE EXCEPTION 'CHANNEL_HAS_PENDING_WORK' USING ERRCODE='23514',CONSTRAINT='lifecycle_pending_work'; END IF;
 IF target.provider='QR' AND EXISTS (SELECT 1 FROM public.provider_operations WHERE organization_id=p_org
   AND instance_id=p_resource AND (status IN ('PENDING','UNKNOWN') OR reconciliation_required)) THEN
  RAISE EXCEPTION 'CHANNEL_HAS_PENDING_WORK' USING ERRCODE='23514',CONSTRAINT='lifecycle_pending_work';
 END IF;
 IF EXISTS(SELECT 1 FROM public.chatwoot_onboarding_operations WHERE organization_id=p_org
   AND (instance_id=p_resource OR channel_id=target.messaging_channel_id)
   AND state IN ('PENDING','RUNNING','UNKNOWN')) THEN
  RAISE EXCEPTION 'CHANNEL_HAS_PENDING_WORK' USING ERRCODE='23514',CONSTRAINT='lifecycle_pending_work';
 END IF;
 IF target.messaging_channel_id IS NOT NULL AND EXISTS(
   SELECT 1 FROM public.flow_chatwoot_bindings b JOIN public.chatwoot_connections c
     ON c.organization_id=b.organization_id AND c.inbox_id=b.inbox_id
   WHERE b.organization_id=p_org AND c.channel_id=target.messaging_channel_id AND b.bot_id IS NOT NULL
 ) THEN RAISE EXCEPTION 'FLOW_REMOTE_BOT_ATTACHED' USING ERRCODE='23514',CONSTRAINT='lifecycle_pending_work'; END IF;
 IF target.messaging_channel_id IS NOT NULL THEN
  PERFORM 1 FROM public.messaging_channels WHERE organization_id=p_org AND id=target.messaging_channel_id FOR UPDATE;
  PERFORM public.lifecycle_cancel_safe_work(p_org,target.messaging_channel_id);
 END IF;
 INSERT INTO public.lifecycle_deletions(organization_id,kind,resource_id,resource_name,messaging_channel_id,
   provider,upstream_key,actor_kind,actor_id,reason,status)
 VALUES(p_org,'CHANNEL',p_resource,p_name,target.messaging_channel_id,target.provider,target.upstream_instance_key,
   p_actor_kind,p_actor,p_reason,'REQUESTED') RETURNING id INTO operation_id;
 UPDATE public.messaging_channels SET deleting_at=now(),bot_public_id=NULL,bot_origin_reference=NULL,updated_at=now()
  WHERE organization_id=p_org AND id=target.messaging_channel_id;
 UPDATE public.automation_bindings SET status='DISABLED',revision=revision+1,updated_at=now()
  WHERE organization_id=p_org AND channel_id=target.messaging_channel_id AND status<>'DISABLED';
 UPDATE public.chatwoot_connections SET status='DISABLED',updated_at=now()
  WHERE organization_id=p_org AND channel_id=target.messaging_channel_id AND status<>'DISABLED';
 IF target.provider='QR' THEN
  INSERT INTO public.lifecycle_cleanup_items(deletion_id,instance_id,upstream_key)
   VALUES(operation_id,p_resource,target.upstream_instance_key);
  UPDATE public.instances SET archived_at=now(),updated_at=now() WHERE organization_id=p_org AND id=p_resource;
 ELSE
  UPDATE public.meta_connections SET status='REVOKED',encrypted_token=NULL,updated_at=now()
   WHERE organization_id=p_org AND id=p_resource;
 END IF;
 RETURN operation_id;
END $$;
ALTER FUNCTION lifecycle_request_channel(uuid,uuid,text,text,text,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_request_channel(uuid,uuid,text,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle_request_channel(uuid,uuid,text,text,text,uuid) TO jrc_platform;

CREATE FUNCTION lifecycle_request_organization(p_org uuid,p_name text,p_reason text,p_actor uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target public.organizations%ROWTYPE; existing public.lifecycle_deletions%ROWTYPE; operation_id uuid;
BEGIN
 IF session_user<>'jrc_platform' OR length(btrim(p_reason)) NOT BETWEEN 5 AND 500
   OR NOT EXISTS(SELECT 1 FROM public.platform_users WHERE id=p_actor AND role='SUPER_ADMIN' AND active) THEN
  RAISE EXCEPTION 'LIFECYCLE_FORBIDDEN' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('lifecycle:'||p_org::text,0));
 IF EXISTS(SELECT 1 FROM public.lifecycle_deletions WHERE kind='CHANNEL'
   AND organization_id=p_org AND status<>'COMPLETED') THEN
  RAISE EXCEPTION 'CHANNEL_DELETION_IN_PROGRESS' USING ERRCODE='23514',CONSTRAINT='lifecycle_conflict';
 END IF;
 SELECT * INTO existing FROM public.lifecycle_deletions WHERE kind='ORGANIZATION' AND resource_id=p_org FOR UPDATE;
 IF FOUND THEN
  IF existing.resource_name IS DISTINCT FROM p_name THEN
   RAISE EXCEPTION 'ORGANIZATION_NAME_MISMATCH' USING ERRCODE='P0002';
  END IF;
  IF existing.status='ACTION_REQUIRED' THEN
   UPDATE public.lifecycle_deletions SET status='REQUESTED',error_code=NULL,lease_token=NULL,lease_expires_at=NULL,
     actor_id=p_actor,reason=p_reason,updated_at=now()
    WHERE id=existing.id;
  END IF;
  RETURN existing.id;
 END IF;
 SELECT * INTO target FROM public.organizations WHERE id=p_org FOR UPDATE;
 IF NOT FOUND OR target.name IS DISTINCT FROM p_name THEN
  RAISE EXCEPTION 'ORGANIZATION_NOT_FOUND_OR_NAME_MISMATCH' USING ERRCODE='P0002';
 END IF;
 PERFORM 1 FROM public.chatwoot_provisioning WHERE organization_id=p_org FOR UPDATE;
 PERFORM 1 FROM public.chatwoot_embed_apps WHERE organization_id=p_org ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.chatwoot_provisioning WHERE organization_id=p_org
   AND (state IN ('PENDING','RUNNING','UNKNOWN') OR lease_token IS NOT NULL))
   OR EXISTS(SELECT 1 FROM public.chatwoot_embed_apps WHERE organization_id=p_org
     AND (install_state='UNKNOWN' OR install_lease IS NOT NULL))
   OR EXISTS(SELECT 1 FROM public.flow_chatwoot_bindings WHERE organization_id=p_org AND bot_id IS NOT NULL)
   OR EXISTS(SELECT 1 FROM public.provider_operations WHERE organization_id=p_org
   AND (status IN ('PENDING','UNKNOWN') OR reconciliation_required))
   OR EXISTS(SELECT 1 FROM public.chatwoot_onboarding_operations WHERE organization_id=p_org
     AND state IN ('PENDING','RUNNING','UNKNOWN')) THEN
  RAISE EXCEPTION 'LIFECYCLE_PENDING_WORK' USING ERRCODE='23514',CONSTRAINT='lifecycle_pending_work';
 END IF;
 PERFORM public.lifecycle_cancel_safe_work(p_org,NULL);
 INSERT INTO public.lifecycle_deletions(organization_id,kind,resource_id,resource_name,actor_kind,actor_id,reason,status)
  VALUES(p_org,'ORGANIZATION',p_org,p_name,'PLATFORM',p_actor,p_reason,'REQUESTED') RETURNING id INTO operation_id;
 INSERT INTO public.lifecycle_cleanup_items(deletion_id,instance_id,upstream_key)
  SELECT operation_id,i.id,i.upstream_instance_key FROM public.instances i WHERE i.organization_id=p_org;
 UPDATE public.organizations SET status='DISABLED',updated_at=now() WHERE id=p_org;
 RETURN operation_id;
END $$;
ALTER FUNCTION lifecycle_request_organization(uuid,text,text,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_request_organization(uuid,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle_request_organization(uuid,text,text,uuid) TO jrc_platform;

CREATE FUNCTION lifecycle_validate_purge(p_deletion uuid,p_lease uuid,p_kind text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE op public.lifecycle_deletions%ROWTYPE;
BEGIN
 IF session_user<>'jrc_lifecycle' THEN RAISE EXCEPTION 'LIFECYCLE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT * INTO op FROM public.lifecycle_deletions WHERE id=p_deletion FOR UPDATE;
 IF NOT FOUND OR op.kind<>p_kind OR op.status<>'REMOVING_DATA' OR p_lease IS NULL
   OR op.lease_token IS NULL OR op.lease_token IS DISTINCT FROM p_lease
   OR op.lease_expires_at IS NULL OR op.lease_expires_at<=now() THEN
  RAISE EXCEPTION 'LIFECYCLE_OPERATION_NOT_READY' USING ERRCODE='23514',CONSTRAINT='lifecycle_operation_not_ready';
 END IF;
 IF op.actor_kind='TENANT' THEN
  IF op.kind<>'CHANNEL' OR NOT EXISTS (SELECT 1 FROM public.memberships m JOIN public.users u ON u.id=m.user_id
    WHERE m.organization_id=op.organization_id AND m.user_id=op.actor_id AND m.status='ACTIVE'
      AND u.status='ACTIVE' AND m.role IN ('OWNER','ADMIN')) THEN
   RAISE EXCEPTION 'LIFECYCLE_ACTOR_REVOKED' USING ERRCODE='42501';
  END IF;
 ELSIF op.actor_kind='PLATFORM' THEN
  IF NOT EXISTS (SELECT 1 FROM public.platform_users u WHERE u.id=op.actor_id AND u.role='SUPER_ADMIN' AND u.active) THEN
   RAISE EXCEPTION 'LIFECYCLE_ACTOR_REVOKED' USING ERRCODE='42501';
  END IF;
 ELSE RAISE EXCEPTION 'LIFECYCLE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF EXISTS (SELECT 1 FROM public.lifecycle_cleanup_items WHERE deletion_id=p_deletion AND status<>'DONE') THEN
  RAISE EXCEPTION 'LIFECYCLE_EXTERNAL_PENDING' USING ERRCODE='23514',CONSTRAINT='lifecycle_external_pending';
 END IF;
 RETURN op.organization_id;
END $$;
ALTER FUNCTION lifecycle_validate_purge(uuid,uuid,text) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_validate_purge(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle_validate_purge(uuid,uuid,text) TO jrc_lifecycle;

CREATE FUNCTION lifecycle_purge_organization(p_deletion uuid,p_lease uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid; candidates uuid[]; remaining text[]; next_table text; unknown_table text;
BEGIN
 org=public.lifecycle_validate_purge(p_deletion,p_lease,'ORGANIZATION');
 IF EXISTS (SELECT 1 FROM public.messaging_messages WHERE organization_id=org AND direction='OUTGOING'
   AND state IN ('ACCEPTED','SENDING','UNKNOWN'))
   OR EXISTS (SELECT 1 FROM public.integration_jobs WHERE organization_id=org AND status IN ('PENDING','RUNNING','UNKNOWN'))
   OR EXISTS (SELECT 1 FROM public.automation_executions WHERE organization_id=org AND status IN ('QUEUED','RUNNING','WAITING','UNKNOWN'))
   OR EXISTS (SELECT 1 FROM public.automation_outbox WHERE organization_id=org AND status IN ('PENDING','SENDING','UNKNOWN'))
   OR EXISTS (SELECT 1 FROM public.flow_chatwoot_outbox WHERE organization_id=org AND status IN ('PENDING','SENDING','UNKNOWN'))
   OR EXISTS (SELECT 1 FROM public.provider_operations WHERE organization_id=org AND (status IN ('PENDING','UNKNOWN') OR reconciliation_required))
   OR EXISTS (SELECT 1 FROM public.chatwoot_onboarding_operations WHERE organization_id=org AND state IN ('PENDING','RUNNING','UNKNOWN'))
   OR EXISTS (SELECT 1 FROM public.chatwoot_provisioning WHERE organization_id=org
      AND (state IN ('PENDING','RUNNING','UNKNOWN') OR lease_token IS NOT NULL))
   OR EXISTS (SELECT 1 FROM public.chatwoot_embed_apps WHERE organization_id=org
      AND (install_state='UNKNOWN' OR install_lease IS NOT NULL))
   OR EXISTS (SELECT 1 FROM public.messaging_bot_jobs WHERE organization_id=org
      AND (status IN ('RUNNING','UNKNOWN') OR lease_token IS NOT NULL))
   OR EXISTS (SELECT 1 FROM public.flow_chatwoot_bindings WHERE organization_id=org AND bot_id IS NOT NULL)
 THEN RAISE EXCEPTION 'LIFECYCLE_PENDING_WORK' USING ERRCODE='23514',CONSTRAINT='lifecycle_pending_work'; END IF;
 -- Any newly introduced tenant table requires an explicit catalogue update before deletion.
 SELECT c.relname INTO unknown_table FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
  WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT IN ('lifecycle_deletions','lifecycle_cleanup_items')
   AND NOT EXISTS (SELECT 1 FROM public.lifecycle_purge_catalogue p WHERE p.table_name=c.relname) LIMIT 1;
 IF unknown_table IS NOT NULL THEN
  RAISE EXCEPTION 'LIFECYCLE_CATALOGUE_STALE' USING ERRCODE='23514',CONSTRAINT='lifecycle_catalogue_stale';
 END IF;
 SELECT array_agg(user_id) INTO candidates FROM public.memberships WHERE organization_id=org;
 SELECT array_agg(table_name) INTO remaining FROM public.lifecycle_purge_catalogue;
 SET CONSTRAINTS ALL DEFERRED;
 WHILE coalesce(array_length(remaining,1),0)>0 LOOP
  SELECT candidate INTO next_table FROM unnest(remaining) AS candidate
   WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint fk JOIN unnest(remaining) AS child ON fk.conrelid=to_regclass(format('public.%I',child))
     WHERE fk.contype='f' AND fk.confrelid=to_regclass(format('public.%I',candidate))
       AND child<>candidate AND NOT fk.condeferrable
   ) ORDER BY candidate LIMIT 1;
  IF next_table IS NULL THEN
   RAISE EXCEPTION 'LIFECYCLE_FK_CYCLE' USING ERRCODE='23514',CONSTRAINT='lifecycle_fk_cycle';
  END IF;
  EXECUTE format('DELETE FROM public.%I WHERE organization_id=$1',next_table) USING org;
  remaining=array_remove(remaining,next_table);
  next_table=NULL;
 END LOOP;
 DELETE FROM public.organizations WHERE id=org;
 -- Shared users survive; exclusive users lose their sessions by ON DELETE CASCADE.
 DELETE FROM public.users u WHERE u.id=ANY(candidates) AND NOT EXISTS
   (SELECT 1 FROM public.memberships m WHERE m.user_id=u.id);
 DELETE FROM public.lifecycle_cleanup_items WHERE deletion_id=p_deletion;
 UPDATE public.lifecycle_deletions SET status='COMPLETED',resource_name=NULL,reason=NULL,upstream_key=NULL,
   lease_token=NULL,lease_expires_at=NULL,completed_at=now(),updated_at=now(),error_code=NULL WHERE id=p_deletion;
END $$;
ALTER FUNCTION lifecycle_purge_organization(uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_purge_organization(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle_purge_organization(uuid,uuid) TO jrc_lifecycle;

CREATE FUNCTION lifecycle_purge_channel(p_deletion uuid,p_lease uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE op public.lifecycle_deletions%ROWTYPE; org uuid; channel uuid; resource uuid;
BEGIN
 org=public.lifecycle_validate_purge(p_deletion,p_lease,'CHANNEL');
 SELECT * INTO op FROM public.lifecycle_deletions WHERE id=p_deletion FOR UPDATE;
 channel=op.messaging_channel_id;resource=op.resource_id;
 IF channel IS NOT NULL AND (
   EXISTS(SELECT 1 FROM public.messaging_messages WHERE organization_id=org AND channel_id=channel
     AND direction='OUTGOING' AND state IN ('ACCEPTED','SENDING','UNKNOWN'))
   OR EXISTS(SELECT 1 FROM public.automation_executions WHERE organization_id=org AND channel_id=channel
     AND status IN ('QUEUED','RUNNING','WAITING','UNKNOWN'))
   OR EXISTS(SELECT 1 FROM public.automation_outbox o JOIN public.automation_executions e
     ON e.organization_id=o.organization_id AND e.id=o.execution_id
     WHERE e.organization_id=org AND e.channel_id=channel AND o.status IN ('PENDING','SENDING','UNKNOWN'))
   OR EXISTS(SELECT 1 FROM public.integration_jobs j JOIN public.chatwoot_connections c
     ON c.organization_id=j.organization_id AND c.id=j.integration_id
     WHERE c.organization_id=org AND c.channel_id=channel AND j.status IN ('PENDING','RUNNING','UNKNOWN'))
   OR EXISTS(SELECT 1 FROM public.flow_chatwoot_outbox o JOIN public.flow_chatwoot_bindings b
     ON b.organization_id=o.organization_id AND b.id=o.binding_id
     JOIN public.chatwoot_connections c ON c.organization_id=b.organization_id AND c.inbox_id=b.inbox_id
     WHERE c.organization_id=org AND c.channel_id=channel AND o.status IN ('PENDING','SENDING','UNKNOWN'))
   OR EXISTS(SELECT 1 FROM public.messaging_bot_jobs j JOIN public.messaging_conversations v
     ON v.organization_id=j.organization_id AND v.id=j.conversation_id
     WHERE j.organization_id=org AND v.channel_id=channel
       AND (j.status IN ('RUNNING','UNKNOWN') OR j.lease_token IS NOT NULL))
   OR EXISTS(SELECT 1 FROM public.flow_chatwoot_bindings b JOIN public.chatwoot_connections c
     ON c.organization_id=b.organization_id AND c.inbox_id=b.inbox_id
     WHERE b.organization_id=org AND c.channel_id=channel AND b.bot_id IS NOT NULL)
 ) THEN RAISE EXCEPTION 'CHANNEL_HAS_PENDING_WORK' USING ERRCODE='23514',CONSTRAINT='lifecycle_pending_work'; END IF;
 IF op.provider='QR' AND EXISTS(SELECT 1 FROM public.provider_operations WHERE organization_id=org AND instance_id=resource
   AND (status IN ('PENDING','UNKNOWN') OR reconciliation_required)) THEN
  RAISE EXCEPTION 'CHANNEL_HAS_PENDING_WORK' USING ERRCODE='23514',CONSTRAINT='lifecycle_pending_work';
 END IF;
 IF EXISTS(SELECT 1 FROM public.chatwoot_onboarding_operations WHERE organization_id=org
   AND (instance_id=resource OR channel_id=channel) AND state IN ('PENDING','RUNNING','UNKNOWN')) THEN
  RAISE EXCEPTION 'CHANNEL_HAS_PENDING_WORK' USING ERRCODE='23514',CONSTRAINT='lifecycle_pending_work';
 END IF;
 -- Remove the complete channel-owned execution tree before the binding or message it references.
 DELETE FROM public.automation_reconciliations x USING public.automation_executions e
  WHERE x.organization_id=org AND x.organization_id=e.organization_id AND x.execution_id=e.id AND e.channel_id=channel;
 DELETE FROM public.automation_io_audit x USING public.automation_executions e
  WHERE x.organization_id=org AND x.organization_id=e.organization_id AND x.execution_id=e.id AND e.channel_id=channel;
 DELETE FROM public.automation_child_executions x USING public.automation_executions e
  WHERE x.organization_id=org AND x.organization_id=e.organization_id AND x.parent_execution_id=e.id AND e.channel_id=channel;
 DELETE FROM public.automation_node_executions x USING public.automation_executions e
  WHERE x.organization_id=org AND x.organization_id=e.organization_id AND x.execution_id=e.id AND e.channel_id=channel;
 DELETE FROM public.automation_events x USING public.automation_executions e
  WHERE x.organization_id=org AND x.organization_id=e.organization_id AND x.execution_id=e.id AND e.channel_id=channel;
 DELETE FROM public.automation_waits x USING public.automation_executions e
  WHERE x.organization_id=org AND x.organization_id=e.organization_id AND x.execution_id=e.id AND e.channel_id=channel;
 DELETE FROM public.automation_outbox x USING public.automation_executions e
  WHERE x.organization_id=org AND x.organization_id=e.organization_id AND x.execution_id=e.id AND e.channel_id=channel;
 DELETE FROM public.automation_executions WHERE organization_id=org AND channel_id=channel;
 DELETE FROM public.automation_webhooks w USING public.automation_bindings b
  WHERE w.organization_id=org AND w.organization_id=b.organization_id AND w.binding_id=b.id AND b.channel_id=channel;
 DELETE FROM public.automation_bindings WHERE organization_id=org AND channel_id=channel;
 DELETE FROM public.automation_owner_transitions WHERE organization_id=org AND channel_id=channel;
 -- A Chatwoot inbox and its remote conversations remain external. Only local mirror/bot state is removed.
 DELETE FROM public.flow_chatwoot_outbox x USING public.flow_chatwoot_bindings b,public.chatwoot_connections c
  WHERE x.organization_id=org AND x.organization_id=b.organization_id AND x.binding_id=b.id
   AND b.organization_id=c.organization_id AND b.inbox_id=c.inbox_id AND c.channel_id=channel;
 DELETE FROM public.flow_chatwoot_events x USING public.flow_chatwoot_bindings b,public.chatwoot_connections c
  WHERE x.organization_id=org AND x.organization_id=b.organization_id AND x.binding_id=b.id
   AND b.organization_id=c.organization_id AND b.inbox_id=c.inbox_id AND c.channel_id=channel;
 DELETE FROM public.flow_chatwoot_sessions x USING public.flow_chatwoot_bindings b,public.chatwoot_connections c
  WHERE x.organization_id=org AND x.organization_id=b.organization_id AND x.binding_id=b.id
   AND b.organization_id=c.organization_id AND b.inbox_id=c.inbox_id AND c.channel_id=channel;
 DELETE FROM public.flow_chatwoot_bindings b USING public.chatwoot_connections c
  WHERE b.organization_id=org AND b.organization_id=c.organization_id AND b.inbox_id=c.inbox_id AND c.channel_id=channel;
 DELETE FROM public.chatwoot_onboarding_operations WHERE organization_id=org AND
   (channel_id=channel OR instance_id=resource OR integration_id IN
     (SELECT id FROM public.chatwoot_connections WHERE organization_id=org AND channel_id=channel));
 DELETE FROM public.integration_jobs j USING public.chatwoot_connections c
  WHERE j.organization_id=org AND j.organization_id=c.organization_id AND j.integration_id=c.id AND c.channel_id=channel;
 DELETE FROM public.chatwoot_messages m USING public.chatwoot_connections c
  WHERE m.organization_id=org AND m.organization_id=c.organization_id AND m.integration_id=c.id AND c.channel_id=channel;
 DELETE FROM public.chatwoot_conversations v USING public.chatwoot_connections c
  WHERE v.organization_id=org AND v.organization_id=c.organization_id AND v.integration_id=c.id AND c.channel_id=channel;
 DELETE FROM public.chatwoot_connection_health WHERE organization_id=org AND channel_id=channel;
 DELETE FROM public.chatwoot_operator_grants g USING public.chatwoot_connections c
  WHERE g.organization_id=org AND g.organization_id=c.organization_id AND g.integration_id=c.id AND c.channel_id=channel;
 DELETE FROM public.integration_audit WHERE organization_id=org AND
   (resource_id=resource OR resource_id=channel OR resource_id IN
     (SELECT id FROM public.chatwoot_connections WHERE organization_id=org AND channel_id=channel));
 DELETE FROM public.chatwoot_connections WHERE organization_id=org AND channel_id=channel;
 DELETE FROM public.flow_outputs x USING public.flow_runs r,public.messaging_conversations v
  WHERE x.organization_id=org AND x.organization_id=r.organization_id AND x.incoming_message_id=r.message_id
   AND r.organization_id=v.organization_id AND r.conversation_id=v.id AND v.channel_id=channel;
 DELETE FROM public.flow_runs r USING public.messaging_conversations v
  WHERE r.organization_id=org AND r.organization_id=v.organization_id AND r.conversation_id=v.id AND v.channel_id=channel;
 DELETE FROM public.flow_sessions s USING public.messaging_conversations v
  WHERE s.organization_id=org AND s.organization_id=v.organization_id AND s.conversation_id=v.id AND v.channel_id=channel;
 DELETE FROM public.messaging_inbox_events WHERE organization_id=org AND channel_id=channel;
 DELETE FROM public.messaging_status_events WHERE organization_id=org AND channel_id=channel;
 DELETE FROM public.messaging_bot_jobs j USING public.messaging_conversations v
  WHERE j.organization_id=org AND j.organization_id=v.organization_id AND j.conversation_id=v.id AND v.channel_id=channel;
 DELETE FROM public.messaging_outbox o USING public.messaging_messages m
  WHERE o.organization_id=org AND o.organization_id=m.organization_id AND o.message_id=m.id AND m.channel_id=channel;
 DELETE FROM public.messaging_messages WHERE organization_id=org AND channel_id=channel;
 DELETE FROM public.messaging_media WHERE organization_id=org AND channel_id=channel;
 DELETE FROM public.messaging_conversations WHERE organization_id=org AND channel_id=channel;
 DELETE FROM public.meta_connections WHERE organization_id=org AND id=resource AND op.provider='META';
 DELETE FROM public.messaging_channels WHERE organization_id=org AND id=channel;
 IF op.provider='QR' THEN
  DELETE FROM public.idempotency_records WHERE organization_id=org AND operation_id IN
   (SELECT id FROM public.provider_operations WHERE organization_id=org AND instance_id=resource);
  DELETE FROM public.connection_challenges WHERE organization_id=org AND instance_id=resource;
  DELETE FROM public.provider_operations WHERE organization_id=org AND instance_id=resource;
  DELETE FROM public.instances WHERE organization_id=org AND id=resource;
 END IF;
 DELETE FROM public.audit_logs WHERE organization_id=org AND resource_id IN (resource,channel);
 DELETE FROM public.lifecycle_cleanup_items WHERE deletion_id=p_deletion;
 UPDATE public.lifecycle_deletions SET status='COMPLETED',resource_name=NULL,reason=NULL,upstream_key=NULL,
   lease_token=NULL,lease_expires_at=NULL,completed_at=now(),updated_at=now(),error_code=NULL WHERE id=p_deletion;
END $$;
ALTER FUNCTION lifecycle_purge_channel(uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_purge_channel(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle_purge_channel(uuid,uuid) TO jrc_lifecycle;

CREATE FUNCTION lifecycle_pending_count(p_org uuid,p_channel uuid,p_resource uuid)
RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT
  (SELECT count(*) FROM public.messaging_messages WHERE organization_id=p_org
    AND (p_channel IS NULL OR channel_id=p_channel) AND direction='OUTGOING' AND state IN ('SENDING','UNKNOWN'))
  +(SELECT count(*) FROM public.messaging_outbox o JOIN public.messaging_messages m
    ON m.organization_id=o.organization_id AND m.id=o.message_id
    WHERE o.organization_id=p_org AND (p_channel IS NULL OR m.channel_id=p_channel) AND o.lease_token IS NOT NULL)
  +(SELECT count(*) FROM public.integration_jobs j JOIN public.chatwoot_connections c
    ON c.organization_id=j.organization_id AND c.id=j.integration_id
    WHERE j.organization_id=p_org AND (p_channel IS NULL OR c.channel_id=p_channel)
      AND (j.status IN ('RUNNING','UNKNOWN') OR j.lease_token IS NOT NULL))
  +(SELECT count(*) FROM public.automation_executions e WHERE e.organization_id=p_org
    AND (p_channel IS NULL OR e.channel_id=p_channel)
    AND (e.status IN ('RUNNING','UNKNOWN') OR e.lease_token IS NOT NULL))
  +(SELECT count(*) FROM public.automation_outbox o JOIN public.automation_executions e
    ON e.organization_id=o.organization_id AND e.id=o.execution_id
    WHERE o.organization_id=p_org AND (p_channel IS NULL OR e.channel_id=p_channel)
      AND (o.status IN ('SENDING','UNKNOWN') OR o.lease_token IS NOT NULL))
  +(SELECT count(*) FROM public.flow_chatwoot_outbox o JOIN public.flow_chatwoot_bindings b
    ON b.organization_id=o.organization_id AND b.id=o.binding_id
    LEFT JOIN public.chatwoot_connections c ON c.organization_id=b.organization_id AND c.inbox_id=b.inbox_id
    WHERE o.organization_id=p_org AND (p_channel IS NULL OR c.channel_id=p_channel)
      AND (o.status IN ('SENDING','UNKNOWN') OR o.lease_expires_at IS NOT NULL))
  +(SELECT count(*) FROM public.messaging_bot_jobs j JOIN public.messaging_conversations v
    ON v.organization_id=j.organization_id AND v.id=j.conversation_id
    WHERE j.organization_id=p_org AND (p_channel IS NULL OR v.channel_id=p_channel)
      AND (j.status IN ('RUNNING','UNKNOWN') OR j.lease_token IS NOT NULL))
  +(SELECT count(*) FROM public.messaging_media WHERE organization_id=p_org
    AND (p_channel IS NULL OR channel_id=p_channel) AND lease_token IS NOT NULL)
  +(SELECT count(*) FROM public.provider_operations WHERE organization_id=p_org
    AND (p_resource IS NULL OR instance_id=p_resource)
    AND (status IN ('PENDING','UNKNOWN') OR reconciliation_required))
  +(SELECT count(*) FROM public.chatwoot_onboarding_operations WHERE organization_id=p_org
    AND (p_resource IS NULL OR instance_id=p_resource OR channel_id=p_channel)
    AND state IN ('PENDING','RUNNING','UNKNOWN'))
  +(SELECT count(*) FROM public.chatwoot_provisioning WHERE organization_id=p_org AND p_resource IS NULL
    AND (state IN ('PENDING','RUNNING','UNKNOWN') OR lease_token IS NOT NULL))
  +(SELECT count(*) FROM public.chatwoot_embed_apps WHERE organization_id=p_org AND p_resource IS NULL
    AND (install_state='UNKNOWN' OR install_lease IS NOT NULL))
  +(SELECT count(*) FROM public.flow_chatwoot_bindings b LEFT JOIN public.chatwoot_connections c
    ON c.organization_id=b.organization_id AND c.inbox_id=b.inbox_id
    WHERE b.organization_id=p_org AND b.bot_id IS NOT NULL
      AND (p_resource IS NULL OR c.channel_id=p_channel));
$$;
ALTER FUNCTION lifecycle_pending_count(uuid,uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_pending_count(uuid,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION lifecycle_preview_channel(p_org uuid,p_resource uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE label text; channel uuid; kind text; messages_count bigint; conversations_count bigint;
 pending_count bigint; affected_bindings bigint; remote_bots bigint; operation_id uuid; operation_status text;
BEGIN
 IF session_user<>'jrc_platform' THEN RAISE EXCEPTION 'LIFECYCLE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT i.name,m.id,'QR' INTO label,channel,kind FROM public.instances i
  LEFT JOIN public.messaging_channels m ON m.organization_id=i.organization_id AND m.instance_id=i.id
  WHERE i.organization_id=p_org AND i.id=p_resource;
 IF NOT FOUND THEN
  SELECT 'WhatsApp oficial',m.channel_id,'META' INTO label,channel,kind
   FROM public.meta_connections m WHERE m.organization_id=p_org AND m.id=p_resource;
 END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'CHANNEL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 SELECT count(*) INTO messages_count FROM public.messaging_messages WHERE organization_id=p_org AND channel_id=channel;
 SELECT count(*) INTO conversations_count FROM public.messaging_conversations WHERE organization_id=p_org AND channel_id=channel;
 SELECT count(*) INTO affected_bindings FROM public.automation_bindings WHERE organization_id=p_org AND channel_id=channel;
 SELECT count(*) INTO remote_bots FROM public.flow_chatwoot_bindings b JOIN public.chatwoot_connections c
   ON c.organization_id=b.organization_id AND c.inbox_id=b.inbox_id
  WHERE b.organization_id=p_org AND c.channel_id=channel AND b.bot_id IS NOT NULL;
 SELECT public.lifecycle_pending_count(p_org,channel,p_resource) INTO pending_count;
 SELECT d.id,d.status INTO operation_id,operation_status FROM public.lifecycle_deletions d
  WHERE d.organization_id=p_org AND d.kind='CHANNEL' AND d.resource_id=p_resource;
 RETURN jsonb_build_object('resourceId',p_resource,'resourceName',label,'kind','CHANNEL',
  'canDelete',pending_count=0,'blockers',CASE WHEN pending_count=0 THEN '[]'::jsonb
    WHEN remote_bots>0 THEN '["FLOW_REMOTE_BOT_ATTACHED"]'::jsonb ELSE '["PENDING_OR_UNCERTAIN_WORK"]'::jsonb END,
  'counts',jsonb_build_object('conversations',conversations_count,'messages',messages_count,'automationBindings',affected_bindings,'remoteFlowBots',remote_bots),
  'operationId',operation_id,'operationStatus',operation_status,
  'externalEffects',CASE WHEN kind='QR' THEN '["Evolution: sessão removida após confirmação; Chatwoot externo preservado"]'::jsonb
     ELSE '["Meta: vínculo local revogado; WABA e conta empresarial preservados; Chatwoot externo preservado"]'::jsonb END);
END $$;
ALTER FUNCTION lifecycle_preview_channel(uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_preview_channel(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle_preview_channel(uuid,uuid) TO jrc_platform;

CREATE FUNCTION lifecycle_preview_organization(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE label text; members_count bigint; qr_count bigint; meta_count bigint; pending_count bigint;
 remote_bots bigint; operation_id uuid; operation_status text;
BEGIN
 IF session_user<>'jrc_platform' THEN RAISE EXCEPTION 'LIFECYCLE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT name INTO label FROM public.organizations WHERE id=p_org;
 IF NOT FOUND THEN RAISE EXCEPTION 'ORGANIZATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 SELECT count(*) INTO members_count FROM public.memberships WHERE organization_id=p_org;
 SELECT count(*) INTO qr_count FROM public.instances WHERE organization_id=p_org;
 SELECT count(*) INTO meta_count FROM public.meta_connections WHERE organization_id=p_org;
 SELECT count(*) INTO remote_bots FROM public.flow_chatwoot_bindings WHERE organization_id=p_org AND bot_id IS NOT NULL;
 SELECT public.lifecycle_pending_count(p_org,NULL,NULL) INTO pending_count;
 SELECT id,status INTO operation_id,operation_status FROM public.lifecycle_deletions
  WHERE organization_id=p_org AND kind='ORGANIZATION' AND resource_id=p_org;
 RETURN jsonb_build_object('resourceId',p_org,'resourceName',label,'kind','ORGANIZATION',
  'canDelete',pending_count=0,'blockers',CASE WHEN pending_count=0 THEN '[]'::jsonb
    WHEN remote_bots>0 THEN '["FLOW_REMOTE_BOT_ATTACHED"]'::jsonb ELSE '["PENDING_OR_UNCERTAIN_WORK"]'::jsonb END,
  'counts',jsonb_build_object('users',members_count,'qrConnections',qr_count,'metaConnections',meta_count,'remoteFlowBots',remote_bots),
  'operationId',operation_id,'operationStatus',operation_status,
  'externalEffects','["Sessões Evolution removidas e verificadas; vínculos Meta locais revogados; Account, caixas e conversas externas preservadas"]'::jsonb);
END $$;
ALTER FUNCTION lifecycle_preview_organization(uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_preview_organization(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle_preview_organization(uuid) TO jrc_platform;
