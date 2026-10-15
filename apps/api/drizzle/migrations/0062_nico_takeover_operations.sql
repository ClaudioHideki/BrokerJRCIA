CREATE TABLE nico_takeover_operations (
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),channel_id uuid NOT NULL,conversation_id uuid NOT NULL,
 integration_id uuid NOT NULL,remote_conversation_id bigint NOT NULL CHECK(remote_conversation_id BETWEEN 1 AND 9007199254740991),
 request_id uuid NOT NULL,external_actor_id text NOT NULL CHECK(external_actor_id ~ '^[1-9][0-9]{0,15}$'),api_key_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),request_body jsonb,snapshot jsonb NOT NULL,
 state text NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','COMPLETED','CANCELED')),
 message_id bigint CHECK(message_id BETWEEN 1 AND 9007199254740991),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id),UNIQUE(organization_id,request_id),
 FOREIGN KEY(organization_id,channel_id,conversation_id) REFERENCES messaging_conversations(organization_id,channel_id,id),
 FOREIGN KEY(organization_id,channel_id,integration_id) REFERENCES chatwoot_connections(organization_id,channel_id,id),
 FOREIGN KEY(organization_id,api_key_id) REFERENCES api_keys(organization_id,id),
 CONSTRAINT nico_takeover_receipt CHECK((state='COMPLETED')=(message_id IS NOT NULL)),
 CONSTRAINT nico_takeover_snapshot CHECK((jsonb_typeof(snapshot)='object'
  AND snapshot->>'organizationId'=organization_id::text AND snapshot->>'channelId'=channel_id::text
  AND snapshot->>'conversationId'=conversation_id::text AND snapshot->>'integrationId'=integration_id::text
  AND snapshot->>'remoteConversationId'=remote_conversation_id::text AND snapshot->>'origin' ~ '^https://[^/?#@]+$') IS TRUE),
 CHECK(request_body IS NOT NULL OR state='CANCELED')
);
CREATE UNIQUE INDEX nico_takeover_one_open ON nico_takeover_operations(organization_id,conversation_id) WHERE state='OPEN';
CREATE UNIQUE INDEX nico_takeover_message_once ON nico_takeover_operations(organization_id,(snapshot->>'origin'),(snapshot->>'accountId'),message_id) WHERE message_id IS NOT NULL;
ALTER TABLE nico_takeover_operations OWNER TO jrc_migrator;
ALTER TABLE nico_takeover_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nico_takeover_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY nico_takeover_tenant ON nico_takeover_operations TO jrc_app
 USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY lifecycle_migrator ON nico_takeover_operations TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON nico_takeover_operations FROM PUBLIC,jrc_auth,jrc_platform,jrc_lifecycle;
GRANT SELECT,INSERT,UPDATE ON nico_takeover_operations TO jrc_app;
CREATE TRIGGER lifecycle_nico_takeover_block BEFORE INSERT ON nico_takeover_operations FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_channel_write();
CREATE FUNCTION nico_takeover_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF (NEW.organization_id,NEW.id,NEW.channel_id,NEW.conversation_id,NEW.integration_id,NEW.remote_conversation_id,NEW.request_id,
     NEW.external_actor_id,NEW.api_key_id,NEW.fingerprint,NEW.request_body,NEW.snapshot,NEW.created_at)
   IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.channel_id,OLD.conversation_id,OLD.integration_id,OLD.remote_conversation_id,OLD.request_id,
     OLD.external_actor_id,OLD.api_key_id,OLD.fingerprint,OLD.request_body,OLD.snapshot,OLD.created_at)
   OR (OLD.state<>'OPEN' AND (NEW.state,NEW.message_id) IS DISTINCT FROM (OLD.state,OLD.message_id)) THEN
   RAISE EXCEPTION 'NICO_TAKEOVER_IMMUTABLE' USING ERRCODE='23514',CONSTRAINT='nico_takeover_immutable';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION nico_takeover_immutable() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION nico_takeover_immutable() FROM PUBLIC,jrc_auth,jrc_platform,jrc_lifecycle;
CREATE TRIGGER nico_takeover_immutable BEFORE UPDATE ON nico_takeover_operations FOR EACH ROW EXECUTE FUNCTION nico_takeover_immutable();
-- The channel lock serializes all application admission. This last database guard
-- also refuses legacy/manual resume paths that attempt to set BOT directly.
CREATE FUNCTION nico_takeover_prevent_resume() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.mode='BOT' AND EXISTS(SELECT 1 FROM public.nico_takeover_operations WHERE organization_id=NEW.organization_id AND conversation_id=NEW.id AND state='OPEN') THEN
  RAISE EXCEPTION 'NICO_TAKEOVER_OPEN' USING ERRCODE='23514',CONSTRAINT='nico_takeover_open';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION nico_takeover_prevent_resume() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION nico_takeover_prevent_resume() FROM PUBLIC,jrc_auth,jrc_platform,jrc_lifecycle;
CREATE TRIGGER nico_takeover_prevent_resume BEFORE UPDATE OF mode ON messaging_conversations FOR EACH ROW EXECUTE FUNCTION nico_takeover_prevent_resume();
-- PAUSED is permission for the BFF to create its Message. Keep channel-level
-- ownership stable until completion/cancellation so a new remote executor cannot
-- bypass the conversation runtime gate in that interval.
CREATE FUNCTION nico_takeover_freeze_owner() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE org uuid; channel uuid; old_channel uuid; channels uuid[];
BEGIN
 org=CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
 IF TG_TABLE_NAME='flow_chatwoot_bindings' THEN
   SELECT array_agg(channel_id ORDER BY channel_id) INTO channels FROM public.chatwoot_connections WHERE organization_id=org
     AND inbox_id IN (CASE WHEN TG_OP='DELETE' THEN OLD.inbox_id ELSE NEW.inbox_id END,CASE WHEN TG_OP='INSERT' THEN NEW.inbox_id ELSE OLD.inbox_id END);
 ELSE
   channel=CASE WHEN TG_OP='DELETE' THEN OLD.channel_id ELSE NEW.channel_id END;
   old_channel=CASE WHEN TG_OP='UPDATE' THEN OLD.channel_id ELSE channel END;
   channels=ARRAY[channel,old_channel];
 END IF;
 PERFORM 1 FROM public.messaging_channels WHERE organization_id=org AND id=ANY(channels) ORDER BY id FOR NO KEY UPDATE;
 IF EXISTS(SELECT 1 FROM public.nico_takeover_operations WHERE organization_id=org AND channel_id=ANY(channels) AND state='OPEN') THEN
   RAISE EXCEPTION 'NICO_TAKEOVER_OPEN' USING ERRCODE='23514',CONSTRAINT='nico_takeover_open';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION nico_takeover_freeze_owner() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION nico_takeover_freeze_owner() FROM PUBLIC,jrc_auth,jrc_platform,jrc_lifecycle;
CREATE TRIGGER nico_takeover_freeze_owner BEFORE INSERT OR UPDATE OR DELETE ON attendance_owners FOR EACH ROW EXECUTE FUNCTION nico_takeover_freeze_owner();
CREATE TRIGGER nico_takeover_freeze_binding BEFORE INSERT OR UPDATE OR DELETE ON automation_bindings FOR EACH ROW EXECUTE FUNCTION nico_takeover_freeze_owner();
CREATE TRIGGER nico_takeover_freeze_cutover BEFORE INSERT OR UPDATE OR DELETE ON flow_executor_cutovers FOR EACH ROW EXECUTE FUNCTION nico_takeover_freeze_owner();
CREATE TRIGGER nico_takeover_freeze_remote_binding BEFORE INSERT OR UPDATE OR DELETE ON flow_chatwoot_bindings FOR EACH ROW EXECUTE FUNCTION nico_takeover_freeze_owner();
CREATE TRIGGER nico_takeover_freeze_central_cutover BEFORE INSERT OR UPDATE OR DELETE ON central_cutover_operations FOR EACH ROW EXECUTE FUNCTION nico_takeover_freeze_owner();
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('nico_takeover_operations');
--> statement-breakpoint
DO $$ DECLARE original text; patched text; BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 patched=replace(original,'DELETE FROM public.attendance_resume_operations WHERE organization_id=org AND channel_id=channel;',
 'DELETE FROM public.nico_takeover_operations WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.attendance_resume_operations WHERE organization_id=org AND channel_id=channel;');
 IF patched=original THEN RAISE EXCEPTION 'NICO_TAKEOVER_PURGE_UPGRADE_MISMATCH'; END IF;
 EXECUTE patched;
END $$;
ALTER FUNCTION lifecycle_pending_count(uuid,uuid,uuid) RENAME TO lifecycle_pending_count_before_nico_takeover;
CREATE FUNCTION lifecycle_pending_count(p_org uuid,p_channel uuid,p_resource uuid)
RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.lifecycle_pending_count_before_nico_takeover(p_org,p_channel,p_resource)
  +(SELECT count(*) FROM public.nico_takeover_operations WHERE organization_id=p_org AND state='OPEN'
    AND (p_channel IS NULL OR channel_id=p_channel));
$$;
ALTER FUNCTION lifecycle_pending_count(uuid,uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_pending_count(uuid,uuid,uuid),lifecycle_pending_count_before_nico_takeover(uuid,uuid,uuid) FROM PUBLIC,jrc_auth,jrc_app,jrc_platform,jrc_lifecycle;
GRANT EXECUTE ON FUNCTION lifecycle_pending_count(uuid,uuid,uuid) TO jrc_lifecycle;
-- Existing lifecycle admission and final purge already call this internal guard.
ALTER FUNCTION lifecycle_assert_no_attendance_resume(uuid,uuid) RENAME TO lifecycle_assert_no_attendance_resume_before_nico;
CREATE FUNCTION lifecycle_assert_no_attendance_resume(p_org uuid,p_channel uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM public.lifecycle_assert_no_attendance_resume_before_nico(p_org,p_channel);
 PERFORM 1 FROM public.nico_takeover_operations WHERE organization_id=p_org AND (p_channel IS NULL OR channel_id=p_channel) ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.nico_takeover_operations WHERE organization_id=p_org AND (p_channel IS NULL OR channel_id=p_channel) AND state='OPEN') THEN
  RAISE EXCEPTION 'LIFECYCLE_PENDING_WORK' USING ERRCODE='23514',CONSTRAINT='lifecycle_pending_work';
 END IF;
END $$;
ALTER FUNCTION lifecycle_assert_no_attendance_resume(uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_assert_no_attendance_resume(uuid,uuid),lifecycle_assert_no_attendance_resume_before_nico(uuid,uuid) FROM PUBLIC,jrc_auth,jrc_app,jrc_platform,jrc_lifecycle;
