CREATE TABLE flow_chatwoot_bindings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 flow_id uuid NOT NULL, inbox_id bigint NOT NULL CHECK(inbox_id>0), account_id bigint NOT NULL,
 destination_revision integer NOT NULL, credential_version integer NOT NULL, feature_revision integer NOT NULL,
 name text NOT NULL, channel_type text NOT NULL, bot_id bigint, encrypted_credentials text,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','READY','FAILED','UNKNOWN','DISABLED')),
 last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), FOREIGN KEY(organization_id,flow_id) REFERENCES flows(organization_id,id)
);
CREATE UNIQUE INDEX flow_chatwoot_active_inbox ON flow_chatwoot_bindings(organization_id,inbox_id) WHERE status<>'DISABLED';
CREATE TABLE flow_chatwoot_sessions (
 organization_id uuid NOT NULL, binding_id uuid NOT NULL, conversation_id bigint NOT NULL,
 version integer, state jsonb, human boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,binding_id,conversation_id),
 FOREIGN KEY(organization_id,binding_id) REFERENCES flow_chatwoot_bindings(organization_id,id)
);
CREATE TABLE flow_chatwoot_events (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), binding_id uuid NOT NULL,
 conversation_id bigint NOT NULL, message_id bigint NOT NULL, payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','DONE','PAUSED','FAILED')),
 trace jsonb NOT NULL DEFAULT '[]', version integer, last_error text,
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,id),
 UNIQUE(organization_id,binding_id,message_id),
 FOREIGN KEY(organization_id,binding_id) REFERENCES flow_chatwoot_bindings(organization_id,id)
);
CREATE TABLE flow_chatwoot_outbox (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), binding_id uuid NOT NULL,
 event_id uuid NOT NULL, conversation_id bigint NOT NULL, ordinal integer NOT NULL,
 kind text NOT NULL CHECK(kind IN ('TEXT','HANDOFF')), content text NOT NULL CHECK(length(content)<=4096),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SENDING','SENT','FAILED','UNKNOWN','CANCELED')),
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 lease_expires_at timestamptz, remote_message_id bigint, last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,id),
 UNIQUE(organization_id,event_id,ordinal),
 FOREIGN KEY(organization_id,event_id) REFERENCES flow_chatwoot_events(organization_id,id),
 FOREIGN KEY(organization_id,binding_id) REFERENCES flow_chatwoot_bindings(organization_id,id)
);
CREATE INDEX flow_chatwoot_pending_events ON flow_chatwoot_events(organization_id,status,available_at,created_at);
CREATE INDEX flow_chatwoot_pending_outbox ON flow_chatwoot_outbox(organization_id,status,available_at);
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['flow_chatwoot_bindings','flow_chatwoot_sessions','flow_chatwoot_events','flow_chatwoot_outbox'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO jrc_migrator',t);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY flow_tenant ON %I TO jrc_app USING (organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth,jrc_platform',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO jrc_app',t);
 END LOOP;
END $$;
CREATE POLICY flow_ingress_resolution ON flow_chatwoot_bindings FOR SELECT TO jrc_migrator USING(true);
CREATE FUNCTION resolve_flow_chatwoot_binding(p_id uuid) RETURNS TABLE(organization_id uuid)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT b.organization_id FROM public.flow_chatwoot_bindings b WHERE b.id=p_id
$$;
ALTER FUNCTION resolve_flow_chatwoot_binding(uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION resolve_flow_chatwoot_binding(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_flow_chatwoot_binding(uuid) TO jrc_app;
