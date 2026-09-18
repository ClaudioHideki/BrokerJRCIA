CREATE TABLE flow_features (
 organization_id uuid PRIMARY KEY REFERENCES organizations(id),
 enabled boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE flows (
 organization_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120), graph jsonb NOT NULL,
 revision integer NOT NULL DEFAULT 1, published_version integer,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id), CHECK(octet_length(graph::text)<=500000)
);
CREATE TABLE flow_versions (
 organization_id uuid NOT NULL, flow_id uuid NOT NULL, version integer NOT NULL,
 graph jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,flow_id,version),
 FOREIGN KEY(organization_id,flow_id) REFERENCES flows(organization_id,id)
);
CREATE TABLE flow_sessions (
 organization_id uuid NOT NULL, conversation_id uuid NOT NULL,
 flow_id uuid NOT NULL, version integer NOT NULL, feature_revision integer NOT NULL,
 state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,conversation_id),
 FOREIGN KEY(organization_id,conversation_id) REFERENCES messaging_conversations(organization_id,id),
 FOREIGN KEY(organization_id,flow_id,version) REFERENCES flow_versions(organization_id,flow_id,version)
);
CREATE TABLE flow_runs (
 organization_id uuid NOT NULL, message_id uuid NOT NULL, conversation_id uuid NOT NULL,
 flow_id uuid NOT NULL, version integer NOT NULL, feature_revision integer NOT NULL,
 status text NOT NULL CHECK(status IN ('waiting','completed','handoff','paused','failed')),
 trace jsonb NOT NULL DEFAULT '[]', error_code text, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,message_id),
 FOREIGN KEY(organization_id,message_id) REFERENCES messaging_messages(organization_id,id),
 FOREIGN KEY(organization_id,conversation_id) REFERENCES messaging_conversations(organization_id,id),
 FOREIGN KEY(organization_id,flow_id,version) REFERENCES flow_versions(organization_id,flow_id,version)
);
CREATE TABLE flow_outputs (
 organization_id uuid NOT NULL, message_id uuid NOT NULL, incoming_message_id uuid NOT NULL,
 PRIMARY KEY(organization_id,message_id),
 FOREIGN KEY(organization_id,message_id) REFERENCES messaging_messages(organization_id,id),
 FOREIGN KEY(organization_id,incoming_message_id) REFERENCES flow_runs(organization_id,message_id)
);
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['flow_features','flows','flow_versions','flow_sessions','flow_runs','flow_outputs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY flow_tenant ON %I TO jrc_app USING (organization_id = NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_app,jrc_auth,jrc_platform',t);
 END LOOP;
END $$;
GRANT SELECT ON flow_features TO jrc_app;
GRANT SELECT,INSERT,UPDATE ON flow_features TO jrc_platform;
CREATE POLICY flow_platform ON flow_features TO jrc_platform USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE ON flows,flow_sessions,flow_runs TO jrc_app;
GRANT DELETE ON flow_sessions TO jrc_app;
GRANT SELECT,INSERT ON flow_versions,flow_outputs TO jrc_app;
CREATE INDEX flow_runs_recent ON flow_runs(organization_id,flow_id,created_at DESC);
--> statement-breakpoint
CREATE FUNCTION flow_output_allowed(org uuid,msg uuid) RETURNS boolean LANGUAGE sql STABLE
 SET search_path=pg_catalog,public AS $$
 SELECT NOT EXISTS (
  SELECT 1 FROM flow_outputs out
  JOIN flow_runs run ON run.organization_id=out.organization_id AND run.message_id=out.incoming_message_id
  JOIN messaging_messages message ON message.organization_id=out.organization_id AND message.id=out.message_id
  JOIN messaging_channels channel ON channel.organization_id=message.organization_id AND channel.id=message.channel_id
  LEFT JOIN flow_features feature ON feature.organization_id=out.organization_id
  WHERE out.organization_id=org AND out.message_id=msg
    AND (feature.enabled IS DISTINCT FROM true OR feature.revision<>run.feature_revision
      OR channel.bot_origin_reference IS DISTINCT FROM 'jrc-flows-native'
      OR channel.bot_public_id IS DISTINCT FROM run.flow_id::text)
 )
 $$;
REVOKE ALL ON FUNCTION flow_output_allowed(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION flow_output_allowed(uuid,uuid) TO jrc_app;
