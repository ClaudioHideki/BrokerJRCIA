-- Refuse ambiguous legacy ownership. Never silently move a customer's assets.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM meta_connections GROUP BY waba_id HAVING count(DISTINCT organization_id)>1) THEN
  RAISE EXCEPTION 'META_WABA_OWNERSHIP_CONFLICT: reconcile cross-tenant WABA bindings before migration';
 END IF;
END $$;
CREATE TABLE meta_waba_ownership (
 waba_id text PRIMARY KEY CHECK(waba_id ~ '^[0-9]{5,64}$'),
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,waba_id)
);
ALTER TABLE meta_waba_ownership OWNER TO jrc_migrator;
INSERT INTO meta_waba_ownership(waba_id,organization_id)
 SELECT DISTINCT waba_id,organization_id FROM meta_connections;
ALTER TABLE meta_waba_ownership ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_waba_ownership FORCE ROW LEVEL SECURITY;
CREATE POLICY meta_waba_owner_read ON meta_waba_ownership FOR SELECT TO jrc_app
 USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY lifecycle_migrator ON meta_waba_ownership TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON meta_waba_ownership FROM PUBLIC,jrc_app,jrc_auth,jrc_platform;
GRANT SELECT ON meta_waba_ownership TO jrc_app;
-- Ownership is deliberately retained after revocation/channel deletion.
CREATE FUNCTION claim_meta_waba(waba text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public AS $$
DECLARE org uuid := NULLIF(current_setting('app.organization_id',true),'')::uuid;
BEGIN
 IF org IS NULL OR waba IS NULL OR waba !~ '^[0-9]{5,64}$' THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.organizations WHERE id=org AND status='ACTIVE') THEN RETURN false; END IF;
 INSERT INTO public.meta_waba_ownership(waba_id,organization_id) VALUES(waba,org) ON CONFLICT(waba_id) DO NOTHING;
 RETURN EXISTS(SELECT 1 FROM public.meta_waba_ownership WHERE waba_id=waba AND organization_id=org);
END $$;
ALTER FUNCTION claim_meta_waba(text) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION claim_meta_waba(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_meta_waba(text) TO jrc_app;
CREATE FUNCTION enforce_meta_waba_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.organization_id IS DISTINCT FROM NULLIF(current_setting('app.organization_id',true),'')::uuid
    OR NOT public.claim_meta_waba(NEW.waba_id) THEN
  RAISE EXCEPTION 'META_WABA_OWNERSHIP_CONFLICT' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION enforce_meta_waba_owner() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION enforce_meta_waba_owner() FROM PUBLIC;
CREATE TRIGGER meta_waba_owner_guard BEFORE INSERT OR UPDATE OF waba_id,organization_id ON meta_connections
 FOR EACH ROW EXECUTE FUNCTION enforce_meta_waba_owner();
ALTER TABLE meta_connections ADD CONSTRAINT meta_waba_owner_fk FOREIGN KEY(organization_id,waba_id)
 REFERENCES meta_waba_ownership(organization_id,waba_id);
ALTER TABLE meta_connections ADD CONSTRAINT meta_connection_tenant_identity UNIQUE(organization_id,id);
ALTER TABLE meta_connections ADD COLUMN readiness_revision bigint NOT NULL DEFAULT 0 CHECK(readiness_revision>=0);

CREATE TABLE meta_management_events (
 organization_id uuid NOT NULL, connection_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 field text NOT NULL CHECK(field IN ('account_update','account_review_update','phone_number_name_update',
  'phone_number_quality_update','business_capability_update','message_template_status_update','message_template_quality_update')),
 received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,connection_id,fingerprint),
 FOREIGN KEY(organization_id,connection_id) REFERENCES meta_connections(organization_id,id) ON DELETE CASCADE
);
CREATE INDEX meta_management_recent ON meta_management_events(organization_id,connection_id,field,received_at DESC);
ALTER TABLE meta_management_events OWNER TO jrc_migrator;
ALTER TABLE meta_management_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_management_events FORCE ROW LEVEL SECURITY;
CREATE POLICY meta_management_tenant ON meta_management_events TO jrc_app
 USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY lifecycle_migrator ON meta_management_events TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON meta_management_events FROM PUBLIC,jrc_auth,jrc_platform;
GRANT SELECT,INSERT ON meta_management_events TO jrc_app;
-- Every tenant table must participate in the explicit lifecycle catalogue.
-- Channel revocation retains ownership; an authorized full organization purge removes it.
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('meta_waba_ownership'),('meta_management_events');
