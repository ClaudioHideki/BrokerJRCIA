ALTER TABLE organizations ADD COLUMN plan text NOT NULL DEFAULT 'STANDARD' CHECK (length(plan) BETWEEN 1 AND 80);
CREATE TABLE platform_users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE CHECK(email=lower(btrim(email))),
 password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('SUPER_ADMIN','SUPPORT')),
 mfa_seed text NOT NULL, last_totp_step bigint NOT NULL DEFAULT -1,
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES platform_users(id),
 csrf_token text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_sessions_expiry ON platform_sessions(expires_at);
CREATE TABLE platform_login_limits (key text PRIMARY KEY, attempts integer NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE platform_audit_logs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid REFERENCES platform_users(id),
 organization_id uuid REFERENCES organizations(id), action text NOT NULL, reason text NOT NULL CHECK(length(btrim(reason))>=5),
 created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['platform_users','platform_sessions','platform_login_limits','platform_audit_logs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY platform_boundary ON %I TO jrc_platform USING (true) WITH CHECK (true)',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_app,jrc_auth',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON platform_users TO jrc_platform;
GRANT SELECT,INSERT,UPDATE,DELETE ON platform_sessions,platform_login_limits TO jrc_platform;
GRANT SELECT,INSERT ON platform_audit_logs TO jrc_platform;
GRANT SELECT,INSERT,UPDATE ON organizations,memberships TO jrc_platform;
GRANT SELECT(id,email,status), INSERT(id,email,password_hash,status) ON users TO jrc_platform;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['organizations','memberships','users'] LOOP
  EXECUTE format('CREATE POLICY platform_administration ON %I TO jrc_platform USING (true) WITH CHECK (true)',t);
 END LOOP;
END $$;
-- Only non-content columns are exposed to the dedicated boundary for aggregate health.
GRANT SELECT(organization_id,status) ON instances TO jrc_platform;
GRANT SELECT(organization_id,state) ON messaging_messages TO jrc_platform;
GRANT SELECT(organization_id) ON messaging_outbox,messaging_inbox_events TO jrc_platform;
GRANT INSERT(organization_id,provider,name) ON provider_accounts TO jrc_platform;
CREATE POLICY platform_provider_bootstrap ON provider_accounts FOR INSERT TO jrc_platform
 WITH CHECK(provider='BAILEYS' AND credential_reference IS NULL AND external_reference IS NULL);
GRANT SELECT(organization_id) ON messaging_channels TO jrc_platform;
CREATE POLICY platform_channel_monitor ON messaging_channels FOR SELECT TO jrc_platform USING(true);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['instances','messaging_messages','messaging_outbox','messaging_inbox_events'] LOOP
  EXECUTE format('CREATE POLICY platform_monitor ON %I FOR SELECT TO jrc_platform USING (true)',t);
 END LOOP;
END $$;
