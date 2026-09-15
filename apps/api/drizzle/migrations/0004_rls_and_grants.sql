ALTER TABLE organizations OWNER TO jrc_migrator;
ALTER TABLE users OWNER TO jrc_migrator;
ALTER TABLE memberships OWNER TO jrc_migrator;
ALTER TABLE login_sessions OWNER TO jrc_migrator;
ALTER TABLE refresh_tokens OWNER TO jrc_migrator;
ALTER TABLE api_keys OWNER TO jrc_migrator;
ALTER TABLE security_audit_logs OWNER TO jrc_migrator;
ALTER TABLE audit_logs OWNER TO jrc_migrator;
ALTER TABLE provider_accounts OWNER TO jrc_migrator;
ALTER TABLE instances OWNER TO jrc_migrator;
ALTER TABLE provider_operations OWNER TO jrc_migrator;
ALTER TABLE connection_challenges OWNER TO jrc_migrator;
ALTER TABLE idempotency_records OWNER TO jrc_migrator;
ALTER FUNCTION ensure_organization_has_owner() OWNER TO jrc_migrator;
ALTER TYPE organization_status OWNER TO jrc_migrator;
ALTER TYPE user_status OWNER TO jrc_migrator;
ALTER TYPE membership_role OWNER TO jrc_migrator;
ALTER TYPE membership_status OWNER TO jrc_migrator;
ALTER TYPE provider_kind OWNER TO jrc_migrator;
ALTER TYPE instance_status OWNER TO jrc_migrator;
ALTER TYPE provider_operation_status OWNER TO jrc_migrator;
ALTER TYPE idempotency_status OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION ensure_organization_has_owner() FROM PUBLIC;
REVOKE ALL ON TYPE organization_status, user_status, membership_role, membership_status,
  provider_kind, instance_status, provider_operation_status, idempotency_status FROM PUBLIC;
GRANT USAGE ON TYPE organization_status, user_status, membership_role, membership_status,
  provider_kind, instance_status, provider_operation_status, idempotency_status TO jrc_app, jrc_auth;
--> statement-breakpoint
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE provider_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE instances FORCE ROW LEVEL SECURITY;
ALTER TABLE provider_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE connection_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_challenges FORCE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY organizations_tenant_isolation ON organizations
  TO jrc_app
  USING (id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY organizations_auth_read ON organizations FOR SELECT TO jrc_auth USING (true);
CREATE POLICY organizations_migrator_integrity ON organizations
  TO jrc_migrator USING (true) WITH CHECK (true);
CREATE POLICY memberships_tenant_isolation ON memberships
  TO jrc_app
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY memberships_auth_read ON memberships FOR SELECT TO jrc_auth USING (true);
CREATE POLICY memberships_migrator_integrity ON memberships
  TO jrc_migrator USING (true) WITH CHECK (true);
CREATE POLICY refresh_tokens_auth_access ON refresh_tokens TO jrc_auth USING (true) WITH CHECK (true);
CREATE POLICY api_keys_tenant_isolation ON api_keys
  TO jrc_app
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY audit_logs_tenant_insert ON audit_logs
  FOR INSERT TO jrc_app
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY provider_accounts_tenant_isolation ON provider_accounts
  TO jrc_app
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY instances_tenant_isolation ON instances
  TO jrc_app
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY provider_operations_tenant_isolation ON provider_operations
  TO jrc_app
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY connection_challenges_tenant_isolation ON connection_challenges
  TO jrc_app
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY idempotency_records_tenant_isolation ON idempotency_records
  TO jrc_app
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, jrc_app, jrc_auth;
GRANT SELECT ON organizations, users, memberships TO jrc_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON login_sessions, refresh_tokens TO jrc_auth;
GRANT INSERT ON security_audit_logs TO jrc_auth;
GRANT SELECT ON organizations TO jrc_app;
GRANT INSERT ON audit_logs TO jrc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships, api_keys,
  provider_accounts, instances, provider_operations, connection_challenges,
  idempotency_records TO jrc_app;
