CREATE TABLE chatwoot_destinations (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
  base_url text NOT NULL,
  mode text NOT NULL CHECK(mode IN ('MANAGED','EXTERNAL')),
  approval_status text NOT NULL DEFAULT 'PENDING' CHECK(approval_status IN ('PENDING','APPROVED','REVOKED')),
  media_origins jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(media_origins)='array'),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  approval_audit_id uuid REFERENCES platform_audit_logs(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,base_url)
);
ALTER TABLE chatwoot_destinations OWNER TO jrc_migrator;
-- Temporary read policy for upgrading forced-RLS tables; no credential is rewritten.
CREATE POLICY chatwoot_accounts_destination_backfill ON chatwoot_accounts FOR SELECT TO jrc_migrator USING(true);
INSERT INTO chatwoot_destinations(organization_id,base_url,mode,approval_status)
  SELECT organization_id,base_url,'MANAGED','APPROVED' FROM chatwoot_accounts;
DROP POLICY chatwoot_accounts_destination_backfill ON chatwoot_accounts;
ALTER TABLE chatwoot_accounts ADD COLUMN credential_version integer NOT NULL DEFAULT 1 CHECK(credential_version>0);
ALTER TABLE chatwoot_accounts ADD COLUMN capabilities jsonb NOT NULL DEFAULT '{}';
ALTER TABLE chatwoot_accounts ADD COLUMN capabilities_verified_at timestamptz;
ALTER TABLE chatwoot_accounts ADD CONSTRAINT chatwoot_accounts_destination_fk
  FOREIGN KEY(organization_id,base_url) REFERENCES chatwoot_destinations(organization_id,base_url)
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE chatwoot_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatwoot_destinations FORCE ROW LEVEL SECURITY;
CREATE POLICY chatwoot_destinations_tenant ON chatwoot_destinations TO jrc_app
  USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)
  WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY chatwoot_destinations_platform ON chatwoot_destinations TO jrc_platform USING(true) WITH CHECK(true);
CREATE POLICY chatwoot_destinations_legacy_insert ON chatwoot_destinations TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON chatwoot_destinations FROM PUBLIC,jrc_auth;
GRANT SELECT ON chatwoot_destinations TO jrc_app,jrc_platform;
GRANT INSERT(organization_id,base_url,mode),UPDATE(base_url,mode) ON chatwoot_destinations TO jrc_app;
GRANT UPDATE(approval_status,approval_audit_id,approved_at,media_origins,revision,updated_at) ON chatwoot_destinations TO jrc_platform;
--> statement-breakpoint
-- Preserve legacy inserts. New external destinations are created separately, pending approval.
CREATE FUNCTION ensure_managed_chatwoot_destination() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  INSERT INTO public.chatwoot_destinations(organization_id,base_url,mode,approval_status)
    VALUES(NEW.organization_id,NEW.base_url,'MANAGED','APPROVED') ON CONFLICT(organization_id) DO NOTHING;
  RETURN NEW;
END $$;
ALTER FUNCTION ensure_managed_chatwoot_destination() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION ensure_managed_chatwoot_destination() FROM PUBLIC;
CREATE TRIGGER chatwoot_account_managed_destination BEFORE INSERT ON chatwoot_accounts
  FOR EACH ROW EXECUTE FUNCTION ensure_managed_chatwoot_destination();
CREATE FUNCTION invalidate_chatwoot_destination() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF (NEW.base_url,NEW.mode) IS DISTINCT FROM (OLD.base_url,OLD.mode) THEN
    IF EXISTS(SELECT 1 FROM public.chatwoot_connections WHERE organization_id=OLD.organization_id) OR
       EXISTS(SELECT 1 FROM public.chatwoot_provisioning WHERE organization_id=OLD.organization_id AND state IN ('PENDING','RUNNING','UNKNOWN')) THEN
      RAISE EXCEPTION 'DESTINATION_IN_USE' USING ERRCODE='23514';
    END IF;
    NEW.approval_status='PENDING'; NEW.media_origins='[]'; NEW.revision=OLD.revision+1;
    NEW.approval_audit_id=NULL; NEW.approved_at=NULL;
  END IF;
  NEW.updated_at=now(); RETURN NEW;
END $$;
ALTER FUNCTION invalidate_chatwoot_destination() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION invalidate_chatwoot_destination() FROM PUBLIC;
CREATE TRIGGER chatwoot_destination_revision BEFORE UPDATE ON chatwoot_destinations
  FOR EACH ROW EXECUTE FUNCTION invalidate_chatwoot_destination();
