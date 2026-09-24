-- Administrative grouping only. No tenant role acquires cross-organization access.
CREATE TABLE economic_groups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
 revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE economic_group_organizations (
 organization_id uuid PRIMARY KEY REFERENCES organizations(id),
 group_id uuid NOT NULL REFERENCES economic_groups(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX economic_group_members ON economic_group_organizations(group_id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['economic_groups','economic_group_organizations'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY platform_boundary ON %I TO jrc_platform USING (true) WITH CHECK (true)',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_app,jrc_auth',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON economic_groups TO jrc_platform;
GRANT SELECT,INSERT,DELETE ON economic_group_organizations TO jrc_platform;
