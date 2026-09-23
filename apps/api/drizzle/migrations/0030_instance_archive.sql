-- Reversible local archival; no customer data or provider session is deleted.
ALTER TABLE instances ADD COLUMN archived_at timestamptz;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_tenant_operational_limits() RETURNS trigger LANGUAGE plpgsql
 SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE limits public.organization_limits%ROWTYPE; active boolean; used bigint;
BEGIN
 -- Incoming messages and receipts never consume outbound quota.
 IF TG_TABLE_NAME='messaging_messages' THEN
   IF NEW.direction <> 'OUTGOING' THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='memberships' THEN
   IF NEW.status <> 'ACTIVE' THEN RETURN NEW; END IF;
   IF TG_OP='UPDATE' AND OLD.status='ACTIVE' AND OLD.organization_id=NEW.organization_id THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='provider_operations' THEN
   IF NEW.operation_type NOT IN ('CONNECT','PROVISION') THEN RETURN NEW; END IF;
 END IF;
 SELECT status='ACTIVE' INTO active FROM public.organizations WHERE id=NEW.organization_id FOR SHARE;
 IF active IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'ORGANIZATION_NOT_ACTIVE' USING ERRCODE='23514',CONSTRAINT='tenant_organization_active';
 END IF;
 -- Row locking and subsequent volatile queries serialize quota admission under READ COMMITTED.
 SELECT * INTO STRICT limits FROM public.organization_limits WHERE organization_id=NEW.organization_id FOR UPDATE;
 IF TG_TABLE_NAME='messaging_channels' THEN IF NEW.provider='BAILEYS' THEN RETURN NEW; END IF; END IF;
 IF TG_TABLE_NAME IN ('instances','messaging_channels') THEN
   SELECT (SELECT count(*) FROM public.instances WHERE organization_id=NEW.organization_id AND archived_at IS NULL)
        + (SELECT count(*) FROM public.messaging_channels WHERE organization_id=NEW.organization_id AND provider='META') INTO used;
   IF used >= limits.max_instances THEN
     RAISE EXCEPTION 'INSTANCE_LIMIT_REACHED' USING ERRCODE='23514',CONSTRAINT='tenant_instance_limit';
   END IF;
 ELSIF TG_TABLE_NAME='memberships' THEN
   SELECT count(*) INTO used FROM public.memberships WHERE organization_id=NEW.organization_id AND status='ACTIVE';
   IF used >= limits.max_users THEN
     RAISE EXCEPTION 'USER_LIMIT_REACHED' USING ERRCODE='23514',CONSTRAINT='tenant_user_limit';
   END IF;
 ELSIF TG_TABLE_NAME='messaging_messages' THEN
   SELECT count(*) INTO used FROM public.messaging_messages WHERE organization_id=NEW.organization_id
     AND direction='OUTGOING' AND state IN ('ACCEPTED','SENDING','UNKNOWN');
   IF used >= limits.max_pending_messages THEN
     RAISE EXCEPTION 'PENDING_MESSAGE_LIMIT_REACHED' USING ERRCODE='23514',CONSTRAINT='tenant_pending_limit';
   END IF;
   IF TG_OP='INSERT' THEN
   INSERT INTO public.organization_message_usage(organization_id,usage_day,accepted_messages)
     VALUES(NEW.organization_id,(statement_timestamp() AT TIME ZONE 'UTC')::date,1)
     ON CONFLICT(organization_id,usage_day) DO UPDATE
       SET accepted_messages=organization_message_usage.accepted_messages+1
     RETURNING accepted_messages INTO used;
   IF used > limits.messages_per_day THEN
     RAISE EXCEPTION 'DAILY_MESSAGE_LIMIT_REACHED' USING ERRCODE='23514',CONSTRAINT='tenant_daily_limit';
   END IF;
   END IF;
 END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
CREATE TRIGGER tenant_instances_restore_admission BEFORE UPDATE OF archived_at ON instances
 FOR EACH ROW WHEN (OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL)
 EXECUTE FUNCTION enforce_tenant_operational_limits();
--> statement-breakpoint
CREATE FUNCTION reject_archived_instance_use() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE archived timestamptz; target uuid;
BEGIN
 IF TG_TABLE_NAME='provider_operations' THEN target=NEW.instance_id;
 ELSIF TG_TABLE_NAME='messaging_channels' THEN target=NEW.instance_id;
 ELSE
  IF TG_TABLE_NAME='messaging_messages' THEN IF NEW.direction<>'OUTGOING' THEN RETURN NEW; END IF; END IF;
  SELECT instance_id INTO target FROM public.messaging_channels WHERE organization_id=NEW.organization_id AND id=NEW.channel_id;
 END IF;
 IF target IS NULL THEN RETURN NEW; END IF;
 SELECT archived_at INTO archived FROM public.instances WHERE organization_id=NEW.organization_id AND id=target FOR SHARE;
 IF archived IS NOT NULL THEN RAISE EXCEPTION 'CHANNEL_ARCHIVED' USING ERRCODE='23514',CONSTRAINT='instance_archived'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION reject_archived_instance_use() FROM PUBLIC;
CREATE TRIGGER instance_archive_operations BEFORE INSERT ON provider_operations FOR EACH ROW EXECUTE FUNCTION reject_archived_instance_use();
CREATE TRIGGER instance_archive_channels BEFORE INSERT OR UPDATE ON messaging_channels FOR EACH ROW EXECUTE FUNCTION reject_archived_instance_use();
CREATE TRIGGER instance_archive_messages BEFORE INSERT ON messaging_messages FOR EACH ROW EXECUTE FUNCTION reject_archived_instance_use();
CREATE TRIGGER instance_archive_message_retry BEFORE UPDATE OF state ON messaging_messages FOR EACH ROW WHEN (NEW.state='ACCEPTED' AND OLD.state<>NEW.state) EXECUTE FUNCTION reject_archived_instance_use();
CREATE TRIGGER instance_archive_bindings BEFORE INSERT OR UPDATE ON automation_bindings FOR EACH ROW WHEN (NEW.status IN ('ACTIVE','PAUSED')) EXECUTE FUNCTION reject_archived_instance_use();

CREATE TRIGGER instance_archive_executions BEFORE INSERT OR UPDATE OF status ON automation_executions FOR EACH ROW WHEN (NEW.status IN ('QUEUED','RUNNING','WAITING')) EXECUTE FUNCTION reject_archived_instance_use();
CREATE TRIGGER instance_archive_inbox_create BEFORE INSERT ON chatwoot_connections FOR EACH ROW WHEN (NEW.status<>'DISABLED') EXECUTE FUNCTION reject_archived_instance_use();
CREATE TRIGGER instance_archive_inbox_resume BEFORE UPDATE OF status ON chatwoot_connections FOR EACH ROW WHEN (NEW.status<>'DISABLED' AND OLD.status<>NEW.status) EXECUTE FUNCTION reject_archived_instance_use();

--> statement-breakpoint
-- RLS remains mandatory; foreign keys protect used inbox bindings.
GRANT DELETE ON chatwoot_connections TO jrc_app;

--> statement-breakpoint
-- Existing imports are preserved; new destinations must belong to this tenant and this inbox.
ALTER TABLE automation_bindings ADD CONSTRAINT automation_binding_destination
 FOREIGN KEY(organization_id,human_destination_id,channel_id) REFERENCES chatwoot_connections(organization_id,id,channel_id) NOT VALID;

--> statement-breakpoint
-- Administrative metrics need only the provider discriminator, never channel credentials.
GRANT SELECT(provider) ON messaging_channels TO jrc_platform;
