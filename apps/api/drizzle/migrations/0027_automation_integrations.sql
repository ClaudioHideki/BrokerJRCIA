CREATE TABLE automation_credentials (
 organization_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120), type text NOT NULL
   CHECK(type IN ('HTTP_HEADER','BEARER','BASIC','POSTGRES','MYSQL','AI_PROVIDER','GENERIC_JSON')),
 encrypted_secret text, key_version integer NOT NULL CHECK(key_version>0), fingerprint text NOT NULL
   CHECK(fingerprint ~ '^[a-f0-9]{64}$'), metadata jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','REVOKED')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), last_tested_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,name),
 CHECK(octet_length(metadata::text)<=16384),
 CHECK((status='ACTIVE' AND encrypted_secret IS NOT NULL) OR (status='REVOKED' AND encrypted_secret IS NULL))
);
ALTER TABLE automation_waits DROP CONSTRAINT automation_waits_kind_check;
ALTER TABLE automation_waits DROP CONSTRAINT automation_waits_check;
ALTER TABLE automation_waits ADD CONSTRAINT automation_waits_kind_check CHECK(kind IN ('EVENT','DELAY','IO'));
ALTER TABLE automation_waits ADD CONSTRAINT automation_waits_wake_check CHECK((kind='DELAY' AND wake_at IS NOT NULL) OR (kind IN ('EVENT','IO') AND wake_at IS NULL));
ALTER TABLE automation_outbox DROP CONSTRAINT automation_outbox_kind_check;
ALTER TABLE automation_outbox ADD CONSTRAINT automation_outbox_kind_check CHECK(kind IN ('SEND_TEXT','HANDOFF','RESUME_EVENT','IO_HTTP','IO_SQL','IO_CODE','IO_AI'));
CREATE TABLE automation_webhooks (
 organization_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 binding_id uuid NOT NULL, token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 hmac_credential_id uuid, status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','REVOKED')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id), UNIQUE(token_hash),
 FOREIGN KEY(organization_id,binding_id) REFERENCES automation_bindings(organization_id,id),
 FOREIGN KEY(organization_id,hmac_credential_id) REFERENCES automation_credentials(organization_id,id)
);
CREATE TABLE automation_import_artifacts (
 organization_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 source text NOT NULL CHECK(source IN ('JRC','N8N','TYPEBOT')), format_version text,
 encrypted_original text NOT NULL, key_version integer NOT NULL CHECK(key_version>0),
 report jsonb NOT NULL, converted_graph jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id), CHECK(octet_length(report::text)<=250000),
 CHECK(converted_graph IS NULL OR octet_length(converted_graph::text)<=500000)
);
CREATE TABLE automation_io_audit (
 organization_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 execution_id uuid, node_id text NOT NULL CHECK(length(node_id) BETWEEN 1 AND 100), kind text NOT NULL,
 credential_id uuid, outcome text NOT NULL, duration_ms integer NOT NULL CHECK(duration_ms>=0),
 request_bytes integer NOT NULL DEFAULT 0 CHECK(request_bytes>=0), response_bytes integer NOT NULL DEFAULT 0 CHECK(response_bytes>=0),
 detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,id),
 FOREIGN KEY(organization_id,execution_id) REFERENCES automation_executions(organization_id,id),
 FOREIGN KEY(organization_id,credential_id) REFERENCES automation_credentials(organization_id,id),
 CHECK(octet_length(detail::text)<=16384)
);
CREATE TABLE automation_child_executions (
 organization_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 parent_execution_id uuid NOT NULL, node_id text NOT NULL, automation_id uuid NOT NULL, version integer NOT NULL,
 correlation_id uuid NOT NULL, status text NOT NULL CHECK(status IN ('COMPLETED','FAILED')),
 input jsonb NOT NULL DEFAULT '{}', output jsonb NOT NULL DEFAULT '{}', error_code text,
 started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id),
 FOREIGN KEY(organization_id,parent_execution_id) REFERENCES automation_executions(organization_id,id),
 FOREIGN KEY(organization_id,automation_id,version) REFERENCES automation_versions(organization_id,automation_id,version),
 CHECK(octet_length(input::text)<=65536),CHECK(octet_length(output::text)<=65536)
);
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['automation_credentials','automation_webhooks','automation_import_artifacts','automation_io_audit','automation_child_executions'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO jrc_migrator',t);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY automation_integration_tenant ON %I TO jrc_app USING (organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth,jrc_platform',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON automation_credentials,automation_webhooks,automation_import_artifacts,automation_io_audit,automation_child_executions TO jrc_app;
--> statement-breakpoint
CREATE FUNCTION automation_resolve_webhook(candidate_hash text)
RETURNS TABLE(organization_id uuid,webhook_id uuid,binding_id uuid,channel_id uuid,hmac_credential_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT h.organization_id,h.id,h.binding_id,b.channel_id,h.hmac_credential_id
 FROM public.automation_webhooks h JOIN public.automation_bindings b
 ON b.organization_id=h.organization_id AND b.id=h.binding_id
 WHERE h.token_hash=candidate_hash AND h.status='ACTIVE' AND b.status='ACTIVE' LIMIT 1
$$;
ALTER FUNCTION automation_resolve_webhook(text) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION automation_resolve_webhook(text) FROM PUBLIC,jrc_auth,jrc_platform;
GRANT EXECUTE ON FUNCTION automation_resolve_webhook(text) TO jrc_app;
