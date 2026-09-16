CREATE TABLE chatwoot_embed_apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES chatwoot_accounts(organization_id),
  account_id bigint NOT NULL CHECK(account_id>0), destination_revision integer NOT NULL CHECK(destination_revision>0),
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,id), UNIQUE(organization_id,destination_revision)
);
CREATE TABLE chatwoot_embed_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, app_id uuid NOT NULL,
  challenge text NOT NULL CHECK(challenge ~ '^[A-Za-z0-9_-]{43}$'),
  state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','APPROVED','DENIED','CONSUMED')),
  approved_by uuid, credential_version integer, grants jsonb,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '120 seconds',
  next_exchange_at timestamptz, failed_attempts integer NOT NULL DEFAULT 0 CHECK(failed_attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(), consumed_at timestamptz,
  UNIQUE(organization_id,id),
  FOREIGN KEY(organization_id,app_id) REFERENCES chatwoot_embed_apps(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY(organization_id,approved_by) REFERENCES memberships(organization_id,user_id) ON DELETE CASCADE,
  CHECK(state NOT IN ('APPROVED','CONSUMED') OR (approved_by IS NOT NULL AND credential_version IS NOT NULL AND grants IS NOT NULL))
);
CREATE TABLE chatwoot_embed_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, app_id uuid NOT NULL,
  authorization_id uuid NOT NULL UNIQUE, user_id uuid NOT NULL, token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  credential_version integer NOT NULL, grants jsonb NOT NULL, expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,app_id) REFERENCES chatwoot_embed_apps(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY(organization_id,authorization_id) REFERENCES chatwoot_embed_authorizations(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY(organization_id,user_id) REFERENCES memberships(organization_id,user_id) ON DELETE CASCADE
);
CREATE INDEX chatwoot_embed_authorizations_expiry ON chatwoot_embed_authorizations(expires_at);
CREATE INDEX chatwoot_embed_sessions_expiry ON chatwoot_embed_sessions(expires_at);
--> statement-breakpoint
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['chatwoot_embed_apps','chatwoot_embed_authorizations','chatwoot_embed_sessions'] LOOP
    EXECUTE format('ALTER TABLE %I OWNER TO jrc_migrator',tab);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY %I ON %I TO jrc_app USING(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',tab||'_tenant',tab);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO jrc_migrator USING(true)',tab||'_lookup',tab);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth',tab);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO jrc_app',tab);
  END LOOP;
END $$;
-- Public request/token resolution exposes only a tenant identifier, never grants or credentials.
CREATE FUNCTION resolve_chatwoot_embed_app(p_id uuid) RETURNS TABLE(organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT a.organization_id FROM public.chatwoot_embed_apps a WHERE a.id=p_id
$$;
CREATE FUNCTION resolve_chatwoot_embed_request(p_id uuid) RETURNS TABLE(organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT a.organization_id FROM public.chatwoot_embed_authorizations a WHERE a.id=p_id
$$;
CREATE FUNCTION resolve_chatwoot_embed_session(p_hash text) RETURNS TABLE(organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT s.organization_id FROM public.chatwoot_embed_sessions s WHERE s.token_hash=p_hash
$$;
ALTER FUNCTION resolve_chatwoot_embed_app(uuid) OWNER TO jrc_migrator;
ALTER FUNCTION resolve_chatwoot_embed_request(uuid) OWNER TO jrc_migrator;
ALTER FUNCTION resolve_chatwoot_embed_session(text) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION resolve_chatwoot_embed_app(uuid),resolve_chatwoot_embed_request(uuid),resolve_chatwoot_embed_session(text) FROM PUBLIC,jrc_auth;
GRANT EXECUTE ON FUNCTION resolve_chatwoot_embed_app(uuid),resolve_chatwoot_embed_request(uuid),resolve_chatwoot_embed_session(text) TO jrc_app;
