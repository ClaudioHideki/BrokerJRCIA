-- Lease coordinates replicas. UNKNOWN is persisted before any remote POST.
-- A lost response/crashed process can reconcile by URL but never blindly create again.
ALTER TABLE chatwoot_embed_apps
  ADD COLUMN install_state text NOT NULL DEFAULT 'UNCONFIGURED'
    CHECK(install_state IN ('UNCONFIGURED','INSTALLED','MANUAL','UNKNOWN')),
  ADD COLUMN remote_app_id bigint CHECK(remote_app_id>0),
  ADD COLUMN install_lease uuid,
  ADD COLUMN install_lease_until timestamptz,
  ADD CONSTRAINT dashboard_install_lease_pair CHECK((install_lease IS NULL)=(install_lease_until IS NULL));
--> statement-breakpoint
-- Tenant-bound projection; jrc_app still has no direct SELECT on users/password hashes.
CREATE FUNCTION current_chatwoot_operator_members() RETURNS TABLE(user_id uuid,email text,role membership_role)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT m.user_id,u.email,m.role FROM public.memberships m JOIN public.users u ON u.id=m.user_id
  WHERE m.organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid
    AND m.status='ACTIVE' AND u.status='ACTIVE' ORDER BY u.email LIMIT 1000
$$;
ALTER FUNCTION current_chatwoot_operator_members() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION current_chatwoot_operator_members() FROM PUBLIC,jrc_auth;
GRANT EXECUTE ON FUNCTION current_chatwoot_operator_members() TO jrc_app;
