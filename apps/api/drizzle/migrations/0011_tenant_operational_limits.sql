CREATE TABLE organization_limits (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  max_instances integer NOT NULL DEFAULT 5 CHECK (max_instances > 0),
  max_users integer NOT NULL DEFAULT 10 CHECK (max_users > 0),
  messages_per_day integer NOT NULL DEFAULT 1000 CHECK (messages_per_day > 0),
  max_pending_messages integer NOT NULL DEFAULT 1000 CHECK (max_pending_messages > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE organization_message_usage (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  usage_day date NOT NULL,
  accepted_messages integer NOT NULL DEFAULT 0 CHECK (accepted_messages >= 0),
  PRIMARY KEY(organization_id, usage_day)
);
ALTER TABLE organization_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_message_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_message_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY limits_tenant_read ON organization_limits FOR SELECT TO jrc_app
 USING (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY limits_platform ON organization_limits TO jrc_platform USING(true) WITH CHECK(true);
CREATE POLICY limits_integrity ON organization_limits TO jrc_migrator USING(true) WITH CHECK(true);
CREATE POLICY usage_tenant_read ON organization_message_usage FOR SELECT TO jrc_app
 USING (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY usage_platform_read ON organization_message_usage FOR SELECT TO jrc_platform USING(true);
CREATE POLICY usage_integrity ON organization_message_usage TO jrc_migrator USING(true) WITH CHECK(true);
GRANT SELECT ON organization_limits,organization_message_usage TO jrc_app;
GRANT SELECT,INSERT,UPDATE ON organization_limits TO jrc_platform;
GRANT SELECT ON organization_message_usage TO jrc_platform;
INSERT INTO organization_limits(organization_id) SELECT id FROM organizations;
CREATE POLICY messages_quota_integrity ON messaging_messages FOR SELECT TO jrc_migrator USING(true);
INSERT INTO organization_message_usage(organization_id,usage_day,accepted_messages)
 SELECT organization_id,(created_at AT TIME ZONE 'UTC')::date,count(*)::integer
 FROM messaging_messages WHERE direction='OUTGOING'
 GROUP BY organization_id,(created_at AT TIME ZONE 'UTC')::date;
--> statement-breakpoint
CREATE FUNCTION initialize_organization_limits() RETURNS trigger LANGUAGE plpgsql
 SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 INSERT INTO public.organization_limits(organization_id) VALUES(NEW.id);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION initialize_organization_limits() FROM PUBLIC;
CREATE TRIGGER initialize_organization_limits AFTER INSERT ON organizations
 FOR EACH ROW EXECUTE FUNCTION initialize_organization_limits();
-- Explicit owner policies allow narrow integrity triggers to count committed tenant rows.
CREATE POLICY instances_quota_integrity ON instances FOR SELECT TO jrc_migrator USING(true);
CREATE POLICY channels_quota_integrity ON messaging_channels FOR SELECT TO jrc_migrator USING(true);

--> statement-breakpoint
-- Context-bound function; holding the row SHARE lock orders admission against suspension.
CREATE FUNCTION tenant_is_active(target uuid) RETURNS boolean LANGUAGE plpgsql
 SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE active boolean;
BEGIN
 IF target IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid THEN
   RETURN false;
 END IF;
 SELECT status='ACTIVE' INTO active FROM public.organizations WHERE id=target FOR SHARE;
 RETURN coalesce(active,false);
END $$;
REVOKE ALL ON FUNCTION tenant_is_active(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_is_active(uuid) TO jrc_app;
--> statement-breakpoint
CREATE FUNCTION enforce_tenant_operational_limits() RETURNS trigger LANGUAGE plpgsql
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
 IF TG_TABLE_NAME IN ('instances','messaging_channels') THEN
   SELECT (SELECT count(*) FROM public.instances WHERE organization_id=NEW.organization_id)
        + (SELECT count(*) FROM public.messaging_channels WHERE organization_id=NEW.organization_id) INTO used;
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
REVOKE ALL ON FUNCTION enforce_tenant_operational_limits() FROM PUBLIC;
CREATE TRIGGER tenant_instances_admission BEFORE INSERT ON instances
 FOR EACH ROW EXECUTE FUNCTION enforce_tenant_operational_limits();
CREATE TRIGGER tenant_channels_admission BEFORE INSERT ON messaging_channels
 FOR EACH ROW EXECUTE FUNCTION enforce_tenant_operational_limits();
CREATE TRIGGER tenant_users_admission BEFORE INSERT OR UPDATE ON memberships
 FOR EACH ROW EXECUTE FUNCTION enforce_tenant_operational_limits();
CREATE TRIGGER tenant_messages_admission BEFORE INSERT ON messaging_messages
 FOR EACH ROW EXECUTE FUNCTION enforce_tenant_operational_limits();
CREATE TRIGGER tenant_connections_admission BEFORE INSERT ON provider_operations
 FOR EACH ROW EXECUTE FUNCTION enforce_tenant_operational_limits();
CREATE TRIGGER tenant_api_key_admission BEFORE INSERT ON api_keys
 FOR EACH ROW EXECUTE FUNCTION enforce_tenant_operational_limits();


CREATE TRIGGER tenant_messages_retry_admission BEFORE UPDATE OF state ON messaging_messages
 FOR EACH ROW WHEN (NEW.direction='OUTGOING' AND NEW.state='ACCEPTED' AND OLD.state<>NEW.state)
 EXECUTE FUNCTION enforce_tenant_operational_limits();
