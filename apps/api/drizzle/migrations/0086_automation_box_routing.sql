-- Profiles are separate from ownership: editing routing never resumes/cancels an existing session.
CREATE TABLE automation_box_profile_versions (
 organization_id uuid NOT NULL,channel_id uuid NOT NULL,automation_id uuid NOT NULL,version integer NOT NULL,
 revision integer NOT NULL CHECK(revision>0),config jsonb NOT NULL CHECK(jsonb_typeof(config)='object'),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=65536),
 actor_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,channel_id,automation_id,version,revision),
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,automation_id,version) REFERENCES automation_versions(organization_id,automation_id,version) ON DELETE CASCADE
);
CREATE TABLE automation_box_profile_heads (
 organization_id uuid NOT NULL,channel_id uuid NOT NULL,automation_id uuid NOT NULL,version integer NOT NULL,revision integer NOT NULL,active_revision integer,
 PRIMARY KEY(organization_id,channel_id,automation_id,version),
 FOREIGN KEY(organization_id,channel_id,automation_id,version,revision)
 REFERENCES automation_box_profile_versions(organization_id,channel_id,automation_id,version,revision) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,channel_id,automation_id,version,active_revision)
 REFERENCES automation_box_profile_versions(organization_id,channel_id,automation_id,version,revision)
);
ALTER TABLE automation_box_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_box_profile_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_box_profile_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_box_profile_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_box_profile_versions OWNER TO jrc_migrator;
ALTER TABLE automation_box_profile_heads OWNER TO jrc_migrator;
CREATE POLICY box_profile_tenant ON automation_box_profile_versions TO jrc_app USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY box_profile_tenant ON automation_box_profile_heads TO jrc_app USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY box_profile_migrator ON automation_box_profile_versions TO jrc_migrator USING(true) WITH CHECK(true);
CREATE POLICY box_profile_migrator ON automation_box_profile_heads TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON automation_box_profile_heads,automation_box_profile_versions FROM PUBLIC,jrc_auth,jrc_platform,jrc_app;
GRANT SELECT,INSERT ON automation_box_profile_versions TO jrc_app;
GRANT SELECT,INSERT,UPDATE ON automation_box_profile_heads TO jrc_app;
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('automation_box_profile_heads'),('automation_box_profile_versions');
CREATE FUNCTION reject_automation_box_profile_update() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'FLOW_BOX_PROFILE_IMMUTABLE'; END $$;
ALTER FUNCTION reject_automation_box_profile_update() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION reject_automation_box_profile_update() FROM PUBLIC;
CREATE TRIGGER automation_box_profile_immutable BEFORE UPDATE ON automation_box_profile_versions
 FOR EACH ROW EXECUTE FUNCTION reject_automation_box_profile_update();
CREATE TRIGGER lifecycle_box_profile_version_block BEFORE INSERT ON automation_box_profile_versions
 FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_channel_write();
CREATE TRIGGER lifecycle_box_profile_head_block BEFORE INSERT OR UPDATE ON automation_box_profile_heads
 FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_channel_write();
