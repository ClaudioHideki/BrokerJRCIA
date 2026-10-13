-- G3 candidate only. A real group is a destination, never a fabricated contact.
ALTER TABLE messaging_conversations ADD COLUMN recipient_kind text NOT NULL DEFAULT 'INDIVIDUAL',
 ADD COLUMN group_jid text,ALTER COLUMN contact_id DROP NOT NULL,
 ADD CONSTRAINT messaging_conversation_recipient CHECK(
  (recipient_kind='INDIVIDUAL' AND contact_id IS NOT NULL AND group_jid IS NULL)
  OR (recipient_kind='GROUP' AND contact_id IS NULL AND remote_conversation_key IS NULL
    AND group_jid IS NOT NULL AND length(group_jid)<=128 AND group_jid ~ '^[0-9]+(-[0-9]+)?@g[.]us$')
 );
CREATE UNIQUE INDEX messaging_conversations_group_unique ON messaging_conversations(organization_id,channel_id,group_jid)
 WHERE recipient_kind='GROUP';
ALTER TABLE messaging_conversations ADD CONSTRAINT messaging_conversations_group_scope_unique UNIQUE(organization_id,channel_id,group_jid,id);
ALTER TABLE automation_executions ADD CONSTRAINT automation_executions_conversation_scope_unique UNIQUE(organization_id,channel_id,conversation_id,id);
CREATE INDEX automation_outbox_group_message_origin ON automation_outbox(organization_id,remote_reference) WHERE kind='SEND_TEXT' AND status='SENT';

-- Historical individual IDs retain the empty channel-wide namespace. A GROUP
-- namespace is derived by trusted ingress from its real destination and current
-- physical identity epoch, and remains immutable after admission/dispatch.
ALTER TABLE messaging_messages ADD COLUMN provider_scope text NOT NULL DEFAULT '';
ALTER TABLE qr_outbound_observations ADD COLUMN provider_scope text NOT NULL DEFAULT '';
ALTER TABLE messaging_status_events ADD COLUMN provider_scope text NOT NULL DEFAULT '';
CREATE FUNCTION whatsapp_group_provider_scope(p_org uuid,p_conversation uuid) RETURNS text
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE kind text;group_id text;epoch bigint; BEGIN
 SELECT m.recipient_kind,m.group_jid,k.identity_revision INTO kind,group_id,epoch FROM public.messaging_conversations m
 LEFT JOIN public.whatsapp_group_catalogs k ON k.organization_id=m.organization_id AND k.channel_id=m.channel_id
 WHERE m.organization_id=p_org AND m.id=p_conversation;
 IF kind IS NULL THEN RAISE EXCEPTION 'GROUP_CONVERSATION_NOT_FOUND'; END IF;
 IF kind='INDIVIDUAL' THEN RETURN ''; END IF;
 IF epoch IS NULL THEN RAISE EXCEPTION 'GROUP_IDENTITY_REQUIRED'; END IF;
 RETURN 'g3:'||group_id||':'||epoch::text;
END $$;
ALTER FUNCTION whatsapp_group_provider_scope(uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION whatsapp_group_provider_scope(uuid,uuid) FROM PUBLIC,jrc_auth,jrc_platform;
GRANT EXECUTE ON FUNCTION whatsapp_group_provider_scope(uuid,uuid) TO jrc_app;
CREATE FUNCTION whatsapp_group_message_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF TG_OP='INSERT' THEN NEW.provider_scope:=public.whatsapp_group_provider_scope(NEW.organization_id,NEW.conversation_id);
 ELSIF NEW.provider_scope IS DISTINCT FROM OLD.provider_scope OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
   OR NEW.channel_id IS DISTINCT FROM OLD.channel_id OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id THEN
   RAISE EXCEPTION 'GROUP_PROVIDER_SCOPE_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION whatsapp_group_message_scope() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION whatsapp_group_message_scope() FROM PUBLIC,jrc_auth,jrc_platform;
GRANT EXECUTE ON FUNCTION whatsapp_group_message_scope() TO jrc_app;
CREATE TRIGGER group_message_scope BEFORE INSERT OR UPDATE ON messaging_messages FOR EACH ROW EXECUTE FUNCTION whatsapp_group_message_scope();
CREATE TRIGGER group_observation_scope BEFORE INSERT OR UPDATE ON qr_outbound_observations FOR EACH ROW EXECUTE FUNCTION whatsapp_group_message_scope();
DROP INDEX messaging_messages_upstream_unique;
CREATE UNIQUE INDEX messaging_messages_upstream_unique ON messaging_messages(organization_id,channel_id,provider_scope,upstream_message_id) WHERE upstream_message_id IS NOT NULL;
DO $$ DECLARE key text; BEGIN
 SELECT c.conname INTO key FROM pg_constraint c WHERE c.conrelid='public.qr_outbound_observations'::regclass AND c.contype='u'
 AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='organization_id'),
 (SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='channel_id'),(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='provider_message_id')]::smallint[];
 IF key IS NULL THEN RAISE EXCEPTION 'GROUP_OBSERVATION_SCOPE_UPGRADE_TARGET_MISSING'; END IF;
 EXECUTE format('ALTER TABLE public.qr_outbound_observations DROP CONSTRAINT %I',key);
END $$;
ALTER TABLE qr_outbound_observations ADD CONSTRAINT qr_observation_scoped_id UNIQUE(organization_id,channel_id,provider_scope,provider_message_id);
ALTER TABLE messaging_status_events DROP CONSTRAINT messaging_status_events_dedupe_unique;
ALTER TABLE messaging_status_events ADD CONSTRAINT messaging_status_events_dedupe_unique UNIQUE(organization_id,channel_id,provider_scope,upstream_message_id,state);

CREATE TABLE whatsapp_group_automation_controls (
 organization_id uuid NOT NULL,channel_id uuid NOT NULL,group_jid text NOT NULL,
 conversation_id uuid NOT NULL,binding_id uuid NOT NULL,automation_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 owner_revision integer NOT NULL CHECK(owner_revision>=0),binding_revision integer NOT NULL CHECK(binding_revision>0),
 identity_revision bigint NOT NULL CHECK(identity_revision>0),identity_fingerprint text NOT NULL CHECK(identity_fingerprint ~ '^[a-f0-9]{64}$'),
 webhook_binding_fingerprint text NOT NULL CHECK(webhook_binding_fingerprint ~ '^[a-f0-9]{64}$'),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),enabled boolean NOT NULL DEFAULT false,
 activation_revision integer NOT NULL DEFAULT 1 CHECK(activation_revision>0),
 trigger_text text NOT NULL CHECK(length(trigger_text) BETWEEN 1 AND 64 AND btrim(trigger_text)<>''),
 session_policy text NOT NULL DEFAULT 'INITIATOR_ONLY' CHECK(session_policy='INITIATOR_ONLY'),
 activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 pause_reason text CHECK(pause_reason IN ('HUMAN_ACTION','EXTERNAL_OBSERVED','AUTHORITY_CHANGED','OUTCOME_UNKNOWN')),
 pause_actor_id uuid,configured_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,channel_id,group_jid),UNIQUE(organization_id,conversation_id),UNIQUE(organization_id,channel_id,group_jid,conversation_id),
 CHECK(length(group_jid)<=128 AND group_jid ~ '^[0-9]+(-[0-9]+)?@g[.]us$'),
 CHECK((pause_reason='HUMAN_ACTION' AND pause_actor_id IS NOT NULL) OR (pause_reason IS DISTINCT FROM 'HUMAN_ACTION' AND pause_actor_id IS NULL)),
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id),
 FOREIGN KEY(organization_id,channel_id,group_jid,conversation_id) REFERENCES messaging_conversations(organization_id,channel_id,group_jid,id),
 FOREIGN KEY(organization_id,binding_id) REFERENCES automation_bindings(organization_id,id),
 FOREIGN KEY(organization_id,automation_id,version) REFERENCES automation_versions(organization_id,automation_id,version),
 FOREIGN KEY(organization_id,configured_by) REFERENCES memberships(organization_id,user_id),
 FOREIGN KEY(organization_id,pause_actor_id) REFERENCES memberships(organization_id,user_id)
);
CREATE TABLE whatsapp_group_automation_sessions (
 organization_id uuid NOT NULL,execution_id uuid NOT NULL,channel_id uuid NOT NULL,conversation_id uuid NOT NULL,group_jid text NOT NULL,
 initiator_jid text NOT NULL CHECK(length(initiator_jid)<=128 AND initiator_jid ~ '^([1-9][0-9]{6,14}@s[.]whatsapp[.]net|[0-9]+@lid)$'),
 identity_revision bigint NOT NULL CHECK(identity_revision>0),identity_fingerprint text NOT NULL CHECK(identity_fingerprint ~ '^[a-f0-9]{64}$'),
 control_revision integer NOT NULL CHECK(control_revision>0),started_at timestamptz NOT NULL DEFAULT clock_timestamp(),closed_at timestamptz,
 activation_revision integer NOT NULL CHECK(activation_revision>0),
 PRIMARY KEY(organization_id,execution_id),
 FOREIGN KEY(organization_id,channel_id,conversation_id,execution_id) REFERENCES automation_executions(organization_id,channel_id,conversation_id,id),
 FOREIGN KEY(organization_id,channel_id,group_jid,conversation_id) REFERENCES messaging_conversations(organization_id,channel_id,group_jid,id),
 FOREIGN KEY(organization_id,channel_id,group_jid,conversation_id) REFERENCES whatsapp_group_automation_controls(organization_id,channel_id,group_jid,conversation_id)
);
CREATE UNIQUE INDEX whatsapp_group_one_live_session ON whatsapp_group_automation_sessions(organization_id,channel_id,group_jid)
 WHERE closed_at IS NULL;
CREATE FUNCTION whatsapp_group_session_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF ROW(NEW.organization_id,NEW.execution_id,NEW.channel_id,NEW.conversation_id,NEW.group_jid,NEW.initiator_jid,NEW.identity_revision,NEW.identity_fingerprint,NEW.activation_revision,NEW.started_at)
  IS DISTINCT FROM ROW(OLD.organization_id,OLD.execution_id,OLD.channel_id,OLD.conversation_id,OLD.group_jid,OLD.initiator_jid,OLD.identity_revision,OLD.identity_fingerprint,OLD.activation_revision,OLD.started_at) THEN
  RAISE EXCEPTION 'GROUP_SESSION_IMMUTABLE' USING ERRCODE='23514',CONSTRAINT='group_session_immutable';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION whatsapp_group_session_immutable() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION whatsapp_group_session_immutable() FROM PUBLIC,jrc_auth,jrc_platform;
CREATE TRIGGER whatsapp_group_session_immutable BEFORE UPDATE ON whatsapp_group_automation_sessions FOR EACH ROW EXECUTE FUNCTION whatsapp_group_session_immutable();
CREATE TABLE whatsapp_group_transport_facts (
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),channel_id uuid NOT NULL,conversation_id uuid NOT NULL,
 group_jid text NOT NULL CHECK(length(group_jid)<=128 AND group_jid ~ '^[0-9]+(-[0-9]+)?@g[.]us$'),
 identity_revision bigint NOT NULL CHECK(identity_revision>0),identity_fingerprint text NOT NULL CHECK(identity_fingerprint ~ '^[a-f0-9]{64}$'),
 provider_message_id text NOT NULL CHECK(length(provider_message_id) BETWEEN 1 AND 256),
 from_me boolean NOT NULL,participant_jid text,participant_jid_alt text,
 content jsonb NOT NULL CHECK(content->>'type'='TEXT' AND jsonb_typeof(content->'text')='string' AND length(content->>'text') BETWEEN 1 AND 4096),
 occurred_at timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 disposition text NOT NULL DEFAULT 'RECEIVED' CHECK(disposition IN ('RECEIVED','IGNORED','ROUTED','BROKER_ECHO','EXTERNAL_OBSERVED','RECONCILE')),
 reason text,message_id uuid,observation_id uuid,
 PRIMARY KEY(organization_id,id),UNIQUE(organization_id,channel_id,identity_revision,group_jid,provider_message_id,from_me),
 CHECK(from_me OR participant_jid IS NOT NULL),
 CHECK(participant_jid IS NULL OR (length(participant_jid)<=128 AND participant_jid ~ '^([1-9][0-9]{6,14}(:[0-9]+)?@s[.]whatsapp[.]net|[0-9]+(:[0-9]+)?@lid)$')),
 CHECK(participant_jid_alt IS NULL OR (length(participant_jid_alt)<=128 AND participant_jid_alt ~ '^([1-9][0-9]{6,14}(:[0-9]+)?@s[.]whatsapp[.]net|[0-9]+(:[0-9]+)?@lid)$')),
 FOREIGN KEY(organization_id,channel_id,group_jid,conversation_id) REFERENCES messaging_conversations(organization_id,channel_id,group_jid,id),
 FOREIGN KEY(organization_id,conversation_id,message_id) REFERENCES messaging_messages(organization_id,conversation_id,id),
 FOREIGN KEY(organization_id,observation_id) REFERENCES qr_outbound_observations(organization_id,id)
);
--> statement-breakpoint
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['whatsapp_group_automation_controls','whatsapp_group_automation_sessions','whatsapp_group_transport_facts'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO jrc_migrator',name);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY group_runtime_tenant ON %I TO jrc_app USING(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',name);
  EXECUTE format('CREATE POLICY lifecycle_migrator ON %I TO jrc_migrator USING(true) WITH CHECK(true)',name);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth,jrc_platform',name);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO jrc_app',name);
  EXECUTE format('CREATE TRIGGER lifecycle_group_runtime_block BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_channel_write()',name);
  INSERT INTO lifecycle_purge_catalogue(table_name) VALUES(name);
 END LOOP;
END $$;
-- Existing organization purge derives FK order from the catalogue. Channel
-- purge must remove group children before canonical executions/messages.
DO $$ DECLARE original text;patched text; BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 patched=replace(original,'DELETE FROM public.attendance_sessions WHERE organization_id=org AND channel_id=channel;',
 'DELETE FROM public.whatsapp_group_transport_facts WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.whatsapp_group_automation_sessions WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.whatsapp_group_automation_controls WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.attendance_sessions WHERE organization_id=org AND channel_id=channel;');
 IF patched=original THEN RAISE EXCEPTION 'GROUP_RUNTIME_PURGE_PATCH_TARGET_MISSING'; END IF;
 EXECUTE patched;
END $$;
