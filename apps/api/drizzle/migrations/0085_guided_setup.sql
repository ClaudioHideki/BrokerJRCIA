-- Additive tenant-private manifests; imports do not create bindings or copy credentials.
CREATE TABLE automation_packages (
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 id uuid NOT NULL, data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id),
 CONSTRAINT automation_packages_scope CHECK((jsonb_typeof(data)='object' AND data->>'id'=id::text AND data->>'organizationId'=organization_id::text) IS TRUE)
);
ALTER TABLE automation_packages OWNER TO jrc_migrator;
ALTER TABLE automation_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_packages FORCE ROW LEVEL SECURITY;
CREATE POLICY automation_packages_tenant ON automation_packages TO jrc_app
 USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
REVOKE ALL ON automation_packages FROM PUBLIC,jrc_auth,jrc_platform;
GRANT SELECT,INSERT,UPDATE ON automation_packages TO jrc_app;
CREATE POLICY lifecycle_migrator ON automation_packages TO jrc_migrator USING(true) WITH CHECK(true);
--> statement-breakpoint
CREATE TABLE guided_setup_operations (
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 id uuid NOT NULL, data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id),
 CONSTRAINT guided_setup_scope CHECK((jsonb_typeof(data)='object' AND data->>'id'=id::text AND data->>'organizationId'=organization_id::text) IS TRUE)
);
CREATE INDEX guided_setup_recent ON guided_setup_operations(organization_id,updated_at DESC,id DESC);
ALTER TABLE guided_setup_operations OWNER TO jrc_migrator;
ALTER TABLE guided_setup_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE guided_setup_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY guided_setup_tenant ON guided_setup_operations TO jrc_app
 USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
REVOKE ALL ON guided_setup_operations FROM PUBLIC,jrc_auth,jrc_platform;
GRANT SELECT,INSERT,UPDATE ON guided_setup_operations TO jrc_app;
CREATE POLICY lifecycle_migrator ON guided_setup_operations TO jrc_migrator USING(true) WITH CHECK(true);
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('automation_packages'),('guided_setup_operations');
