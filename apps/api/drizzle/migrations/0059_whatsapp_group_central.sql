-- Group envelopes are remote display entities, never local individual contacts.
CREATE TABLE chatwoot_group_scopes (
 organization_id uuid NOT NULL,scope_key text NOT NULL CHECK(scope_key ~ '^[a-f0-9]{64}$'),
 channel_id uuid NOT NULL,conversation_id uuid NOT NULL,integration_id uuid NOT NULL,
 destination_revision integer NOT NULL CHECK(destination_revision>0),instance_id uuid NOT NULL,
 identity_revision bigint NOT NULL CHECK(identity_revision>0),identity_fingerprint text NOT NULL CHECK(identity_fingerprint ~ '^[a-f0-9]{64}$'),
 group_jid text NOT NULL CHECK(length(group_jid)<=128 AND group_jid ~ '^[0-9]+(-[0-9]+)?@g[.]us$'),
 remote_account_id bigint NOT NULL CHECK(remote_account_id>0),remote_inbox_id bigint NOT NULL CHECK(remote_inbox_id>0),
 remote_contact_id bigint NOT NULL CHECK(remote_contact_id>0),remote_conversation_id bigint NOT NULL CHECK(remote_conversation_id>0),
 source_id text NOT NULL CHECK(length(source_id) BETWEEN 1 AND 256),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),retired_at timestamptz,
 PRIMARY KEY(organization_id,scope_key),
 UNIQUE(organization_id,integration_id,destination_revision,remote_conversation_id),
 FOREIGN KEY(organization_id,channel_id,group_jid,conversation_id) REFERENCES messaging_conversations(organization_id,channel_id,group_jid,id),
 FOREIGN KEY(organization_id,integration_id) REFERENCES chatwoot_connections(organization_id,id),
 FOREIGN KEY(organization_id,instance_id) REFERENCES instances(organization_id,id)
);
CREATE UNIQUE INDEX chatwoot_group_current_scope ON chatwoot_group_scopes(organization_id,integration_id,conversation_id) WHERE retired_at IS NULL;
CREATE TABLE chatwoot_group_replies (
 organization_id uuid NOT NULL,message_id uuid NOT NULL,scope_key text NOT NULL,
 channel_id uuid NOT NULL,conversation_id uuid NOT NULL,observation_id uuid NOT NULL,
 attendance_revision integer NOT NULL CHECK(attendance_revision>=0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,message_id),
 FOREIGN KEY(organization_id,scope_key) REFERENCES chatwoot_group_scopes(organization_id,scope_key),
 FOREIGN KEY(organization_id,conversation_id,message_id) REFERENCES messaging_messages(organization_id,conversation_id,id),
 FOREIGN KEY(organization_id,observation_id) REFERENCES chatwoot_attendance_observations(organization_id,id),
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id)
);
--> statement-breakpoint
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['chatwoot_group_scopes','chatwoot_group_replies'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO jrc_migrator',name);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY group_central_tenant ON %I TO jrc_app USING(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',name);
  EXECUTE format('CREATE POLICY lifecycle_migrator ON %I TO jrc_migrator USING(true) WITH CHECK(true)',name);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth,jrc_platform',name);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO jrc_app',name);
  EXECUTE format('CREATE TRIGGER lifecycle_group_central_block BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_channel_write()',name);
  INSERT INTO lifecycle_purge_catalogue(table_name) VALUES(name);
 END LOOP;
END $$;
GRANT UPDATE(retired_at) ON chatwoot_group_scopes TO jrc_app;
CREATE FUNCTION chatwoot_group_scope_retirement() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF (to_jsonb(NEW)-'retired_at') IS DISTINCT FROM (to_jsonb(OLD)-'retired_at') OR OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL THEN
  RAISE EXCEPTION 'GROUP_CENTRAL_SCOPE_IMMUTABLE' USING ERRCODE='23514';
 END IF;RETURN NEW;
END $$;
ALTER FUNCTION chatwoot_group_scope_retirement() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION chatwoot_group_scope_retirement() FROM PUBLIC,jrc_auth,jrc_platform;
CREATE TRIGGER group_scope_retirement BEFORE UPDATE ON chatwoot_group_scopes FOR EACH ROW EXECUTE FUNCTION chatwoot_group_scope_retirement();
DO $$ DECLARE original text;patched text; BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 patched=replace(original,'DELETE FROM public.chatwoot_attendance_observations WHERE organization_id=org AND channel_id=channel;',
 'DELETE FROM public.chatwoot_group_replies WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.chatwoot_group_scopes WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.chatwoot_attendance_observations WHERE organization_id=org AND channel_id=channel;');
 IF patched=original THEN RAISE EXCEPTION 'GROUP_CENTRAL_PURGE_PATCH_TARGET_MISSING';END IF;EXECUTE patched;
END $$;
