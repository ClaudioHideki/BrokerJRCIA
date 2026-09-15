CREATE TABLE chatwoot_accounts (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
  base_url text NOT NULL,
  account_id bigint,
  encrypted_token text,
  provisioning_key uuid NOT NULL DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','READY','FAILED','UNKNOWN','DISABLED')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(base_url,account_id)
);
CREATE TABLE chatwoot_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES chatwoot_accounts(organization_id) ON DELETE RESTRICT,
  channel_id uuid NOT NULL,
  inbox_id bigint,
  encrypted_webhook_secret text,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','READY','FAILED','UNKNOWN','DISABLED')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,id), UNIQUE(organization_id,channel_id), UNIQUE(organization_id,inbox_id),
  FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id) ON DELETE RESTRICT
);
CREATE TABLE chatwoot_conversations (
  organization_id uuid NOT NULL, integration_id uuid NOT NULL, conversation_id uuid NOT NULL,
  contact_id bigint NOT NULL, source_id text NOT NULL, remote_conversation_id bigint NOT NULL,
  PRIMARY KEY(organization_id,integration_id,conversation_id),
  UNIQUE(organization_id,integration_id,remote_conversation_id),
  FOREIGN KEY(organization_id,integration_id) REFERENCES chatwoot_connections(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,conversation_id) REFERENCES messaging_conversations(organization_id,id) ON DELETE RESTRICT
);
CREATE TABLE chatwoot_messages (
  organization_id uuid NOT NULL, integration_id uuid NOT NULL, message_id uuid NOT NULL, remote_message_id bigint NOT NULL,
  PRIMARY KEY(organization_id,integration_id,message_id), UNIQUE(organization_id,integration_id,remote_message_id),
  FOREIGN KEY(organization_id,integration_id) REFERENCES chatwoot_connections(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,message_id) REFERENCES messaging_messages(organization_id,id) ON DELETE RESTRICT
);
CREATE TABLE integration_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, integration_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('CHATWOOT_REPLY','MIRROR_MESSAGE')),
  dedupe_key text NOT NULL, message_id uuid, payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RUNNING','SUCCEEDED','FAILED','UNKNOWN')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid, lease_expires_at timestamptz, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,id), UNIQUE(organization_id,integration_id,dedupe_key),
  FOREIGN KEY(organization_id,integration_id) REFERENCES chatwoot_connections(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,message_id) REFERENCES messaging_messages(organization_id,id) ON DELETE RESTRICT,
  CHECK((status='RUNNING' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
     OR (status<>'RUNNING' AND lease_token IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX integration_jobs_claim ON integration_jobs(organization_id,status,available_at,created_at);
CREATE TABLE integration_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  actor_id uuid, action text NOT NULL, resource_id uuid, reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE chatwoot_accounts OWNER TO jrc_migrator;
ALTER TABLE chatwoot_connections OWNER TO jrc_migrator;
ALTER TABLE chatwoot_conversations OWNER TO jrc_migrator;
ALTER TABLE chatwoot_messages OWNER TO jrc_migrator;
ALTER TABLE integration_jobs OWNER TO jrc_migrator;
ALTER TABLE integration_audit OWNER TO jrc_migrator;
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['chatwoot_accounts','chatwoot_connections','chatwoot_conversations','chatwoot_messages','integration_jobs','integration_audit'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY %I ON %I TO jrc_app USING(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',tab||'_tenant',tab);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth',tab);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO jrc_app',tab);
  END LOOP;
END $$;
--> statement-breakpoint
-- Only fixed binding identifiers are exposed for signature verification before tenant context exists.
CREATE POLICY chatwoot_ingress_resolution ON chatwoot_connections FOR SELECT TO jrc_migrator USING(true);
CREATE FUNCTION resolve_chatwoot_integration(p_id uuid) RETURNS TABLE(organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT c.organization_id FROM public.chatwoot_connections c WHERE c.id=p_id
$$;
ALTER FUNCTION resolve_chatwoot_integration(uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION resolve_chatwoot_integration(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_chatwoot_integration(uuid) TO jrc_app;
--> statement-breakpoint
-- Message creation and delivery-state changes schedule a durable mirror in the same transaction.
CREATE FUNCTION enqueue_chatwoot_mirror() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.state=OLD.state THEN RETURN NEW; END IF;
  INSERT INTO public.integration_jobs(organization_id,integration_id,kind,dedupe_key,message_id)
    SELECT NEW.organization_id,c.id,'MIRROR_MESSAGE','message:'||NEW.id::text||':'||NEW.state::text,NEW.id
    FROM public.chatwoot_connections c WHERE c.organization_id=NEW.organization_id AND c.channel_id=NEW.channel_id AND c.status IN ('READY','DISABLED')
    ON CONFLICT(organization_id,integration_id,dedupe_key) DO NOTHING;
  RETURN NEW;
END $$;
ALTER FUNCTION enqueue_chatwoot_mirror() OWNER TO jrc_migrator;
CREATE TRIGGER messaging_chatwoot_mirror AFTER INSERT OR UPDATE OF state ON messaging_messages
FOR EACH ROW EXECUTE FUNCTION enqueue_chatwoot_mirror();
--> statement-breakpoint
-- Bounded scheduler returns only organization IDs. Message content remains behind tenant RLS.
CREATE FUNCTION messaging_worker_organizations(p_after uuid,p_limit integer) RETURNS TABLE(organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT o.id FROM public.organizations o WHERE o.status<>'DISABLED' AND (p_after IS NULL OR o.id>p_after)
  ORDER BY o.id LIMIT LEAST(GREATEST(p_limit,1),1000)
$$;
ALTER FUNCTION messaging_worker_organizations(uuid,integer) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION messaging_worker_organizations(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION messaging_worker_organizations(uuid,integer) TO jrc_app;
