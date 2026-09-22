CREATE TABLE automation_definitions (
 organization_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120), lifecycle_status text NOT NULL DEFAULT 'DRAFT'
   CHECK(lifecycle_status IN ('DRAFT','PUBLISHED','ARCHIVED')),
 draft_graph jsonb NOT NULL, draft_revision integer NOT NULL DEFAULT 1 CHECK(draft_revision>0),
 active_version integer, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id), CHECK(octet_length(draft_graph::text)<=500000)
);
CREATE TABLE automation_versions (
 organization_id uuid NOT NULL, automation_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
 graph jsonb NOT NULL, checksum text NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'),
 published_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,automation_id,version),
 FOREIGN KEY(organization_id,automation_id) REFERENCES automation_definitions(organization_id,id),
 CHECK(octet_length(graph::text)<=500000)
);
ALTER TABLE automation_definitions ADD CONSTRAINT automation_active_version_fk
 FOREIGN KEY(organization_id,id,active_version) REFERENCES automation_versions(organization_id,automation_id,version)
 DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE automation_bindings (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), automation_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0), channel_id uuid NOT NULL, human_destination_id uuid,
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','PAUSED','DISABLED')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,id),
 FOREIGN KEY(organization_id,automation_id,version) REFERENCES automation_versions(organization_id,automation_id,version),
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id)
);
CREATE UNIQUE INDEX automation_one_active_channel ON automation_bindings(organization_id,channel_id)
 WHERE status IN ('ACTIVE','PAUSED');
CREATE TABLE automation_executions (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), automation_id uuid NOT NULL,
 version integer NOT NULL, binding_id uuid NOT NULL, channel_id uuid NOT NULL, conversation_id uuid,
 trigger_event_key text NOT NULL CHECK(length(trigger_event_key) BETWEEN 1 AND 300), correlation_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','RUNNING','WAITING','HANDOFF','COMPLETED','FAILED','CANCELED','UNKNOWN')),
 current_node_id text, state jsonb NOT NULL DEFAULT '{}', input jsonb NOT NULL DEFAULT '{}', error_code text,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), lease_token uuid, lease_expires_at timestamptz,
 started_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,binding_id,trigger_event_key),
 FOREIGN KEY(organization_id,binding_id) REFERENCES automation_bindings(organization_id,id),
 FOREIGN KEY(organization_id,automation_id,version) REFERENCES automation_versions(organization_id,automation_id,version),
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id),
 FOREIGN KEY(organization_id,conversation_id) REFERENCES messaging_conversations(organization_id,id),
 CHECK((lease_token IS NULL)=(lease_expires_at IS NULL))
);
CREATE TABLE automation_node_executions (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), execution_id uuid NOT NULL,
 node_id text NOT NULL CHECK(length(node_id) BETWEEN 1 AND 100), ordinal integer NOT NULL CHECK(ordinal>=0),
 status text NOT NULL CHECK(status IN ('RUNNING','WAITING','COMPLETED','FAILED','UNKNOWN')),
 input jsonb NOT NULL DEFAULT '{}', output jsonb NOT NULL DEFAULT '{}', error_code text,
 started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,execution_id,ordinal),
 FOREIGN KEY(organization_id,execution_id) REFERENCES automation_executions(organization_id,id)
);
CREATE TABLE automation_events (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), execution_id uuid,
 event_key text NOT NULL CHECK(length(event_key) BETWEEN 1 AND 300), type text NOT NULL CHECK(length(type) BETWEEN 1 AND 80),
 payload jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CONSUMED','IGNORED')),
 created_at timestamptz NOT NULL DEFAULT now(), consumed_at timestamptz,
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,event_key),
 FOREIGN KEY(organization_id,execution_id) REFERENCES automation_executions(organization_id,id)
);
CREATE TABLE automation_waits (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), execution_id uuid NOT NULL,
 node_id text NOT NULL CHECK(length(node_id) BETWEEN 1 AND 100), kind text NOT NULL CHECK(kind IN ('EVENT','DELAY')),
 status text NOT NULL DEFAULT 'WAITING' CHECK(status IN ('WAITING','RESUMED','CANCELED')),
 wake_at timestamptz, resume_event_key text, state jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), resumed_at timestamptz,
 PRIMARY KEY(organization_id,id), FOREIGN KEY(organization_id,execution_id) REFERENCES automation_executions(organization_id,id),
 CHECK((kind='DELAY' AND wake_at IS NOT NULL) OR (kind='EVENT' AND wake_at IS NULL))
);
CREATE UNIQUE INDEX automation_one_open_wait ON automation_waits(organization_id,execution_id) WHERE status='WAITING';
CREATE INDEX automation_due_waits ON automation_waits(organization_id,wake_at) WHERE status='WAITING' AND kind='DELAY';
CREATE TABLE automation_outbox (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), execution_id uuid NOT NULL,
 node_id text NOT NULL CHECK(length(node_id) BETWEEN 1 AND 100), ordinal integer NOT NULL CHECK(ordinal>=0),
 kind text NOT NULL CHECK(kind IN ('SEND_TEXT','HANDOFF','RESUME_EVENT')),
 payload jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'PENDING'
   CHECK(status IN ('PENDING','SENDING','SENT','FAILED','UNKNOWN','CANCELED')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), available_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid, lease_expires_at timestamptz, remote_reference text, last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,execution_id,node_id,ordinal),
 FOREIGN KEY(organization_id,execution_id) REFERENCES automation_executions(organization_id,id),
 CHECK((lease_token IS NULL)=(lease_expires_at IS NULL))
);
CREATE INDEX automation_pending_executions ON automation_executions(organization_id,status,updated_at);
CREATE INDEX automation_pending_outbox ON automation_outbox(organization_id,status,available_at);
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['automation_definitions','automation_versions','automation_bindings','automation_executions','automation_node_executions','automation_events','automation_waits','automation_outbox'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO jrc_migrator',t);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY automation_tenant ON %I TO jrc_app USING (organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth,jrc_platform',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON automation_definitions,automation_bindings,automation_executions,automation_node_executions,automation_events,automation_waits,automation_outbox TO jrc_app;
GRANT DELETE ON automation_bindings TO jrc_app;
GRANT SELECT,INSERT ON automation_versions TO jrc_app;
--> statement-breakpoint
CREATE FUNCTION automation_worker_organizations(after_id uuid DEFAULT NULL,batch_size integer DEFAULT 100)
RETURNS TABLE(organization_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT q.organization_id FROM (
  SELECT e.organization_id FROM public.automation_executions e WHERE e.status IN ('QUEUED','RUNNING')
  UNION SELECT o.organization_id FROM public.automation_outbox o WHERE o.status IN ('PENDING','SENDING')
  UNION SELECT w.organization_id FROM public.automation_waits w WHERE w.status='WAITING' AND w.kind='DELAY' AND w.wake_at<=now()
 ) q WHERE after_id IS NULL OR q.organization_id>after_id ORDER BY q.organization_id LIMIT LEAST(GREATEST(batch_size,1),1000)
$$;
ALTER FUNCTION automation_worker_organizations(uuid,integer) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION automation_worker_organizations(uuid,integer) FROM PUBLIC,jrc_auth,jrc_platform;
GRANT EXECUTE ON FUNCTION automation_worker_organizations(uuid,integer) TO jrc_app;
