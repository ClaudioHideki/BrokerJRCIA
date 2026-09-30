CREATE TABLE commercial_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid REFERENCES organizations(id),
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
 revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
 legacy boolean NOT NULL DEFAULT false,
 CONSTRAINT commercial_legacy_owner CHECK (legacy=(organization_id IS NOT NULL))
);
-- Usage only needs operational flags, never message content or credentials.
GRANT SELECT(archived_at) ON instances TO jrc_platform;
GRANT SELECT(direction) ON messaging_messages TO jrc_platform;
CREATE TABLE commercial_plan_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid REFERENCES organizations(id),
 plan_id uuid NOT NULL REFERENCES commercial_plans(id),
 version integer NOT NULL CHECK (version>0),
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
 limits jsonb NOT NULL,
 flows_enabled boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(plan_id,version)
);
CREATE TABLE organization_commercial_plans (
 organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
 plan_version_id uuid NOT NULL REFERENCES commercial_plan_versions(id),
 revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
 overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
 updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['commercial_plans','commercial_plan_versions','organization_commercial_plans'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY platform_boundary ON %I TO jrc_platform USING(true) WITH CHECK(true)',tab);
  EXECUTE format('CREATE POLICY maintenance_boundary ON %I TO jrc_migrator USING(true) WITH CHECK(true)',tab);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_app,jrc_auth',tab);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON commercial_plans TO jrc_platform;
GRANT UPDATE(revision) ON commercial_plans TO jrc_platform;
GRANT SELECT,INSERT,UPDATE ON organization_commercial_plans TO jrc_platform;
-- Published values are append-only for the application role.
GRANT SELECT,INSERT ON commercial_plan_versions TO jrc_platform;
GRANT SELECT,DELETE ON organization_commercial_plans TO jrc_lifecycle;
CREATE POLICY lifecycle_boundary ON organization_commercial_plans TO jrc_lifecycle USING(true);
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('organization_commercial_plans'),('commercial_plan_versions'),('commercial_plans');
-- Shared catalog versions have no owner. Private legacy snapshots cannot be
-- reused across companies, even through a direct statement under platform role.
CREATE FUNCTION enforce_commercial_plan_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE owner uuid;
BEGIN
 IF TG_TABLE_NAME='commercial_plan_versions' THEN
  SELECT organization_id INTO owner FROM public.commercial_plans WHERE id=NEW.plan_id;
  IF owner IS DISTINCT FROM NEW.organization_id THEN
   RAISE EXCEPTION 'COMMERCIAL_PLAN_SCOPE' USING ERRCODE='23514',CONSTRAINT='commercial_plan_scope';
  END IF;
 ELSE
  SELECT organization_id INTO owner FROM public.commercial_plan_versions WHERE id=NEW.plan_version_id;
  IF owner IS NOT NULL AND owner<>NEW.organization_id THEN
   RAISE EXCEPTION 'COMMERCIAL_PLAN_SCOPE' USING ERRCODE='23514',CONSTRAINT='commercial_plan_scope';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION enforce_commercial_plan_scope() FROM PUBLIC;
CREATE TRIGGER commercial_version_scope BEFORE INSERT ON commercial_plan_versions FOR EACH ROW EXECUTE FUNCTION enforce_commercial_plan_scope();
CREATE TRIGGER commercial_assignment_scope BEFORE INSERT OR UPDATE ON organization_commercial_plans FOR EACH ROW EXECUTE FUNCTION enforce_commercial_plan_scope();
-- A private legacy snapshot per company preserves every existing module and limit;
-- it never deduces entitlements from a textual marketing label.
DO $$ DECLARE item record; plan uuid; version_id uuid; BEGIN
 FOR item IN SELECT o.id,o.plan,coalesce(f.enabled,false) AS flows_enabled,
  jsonb_build_object('maxInstances',l.max_instances,'maxUsers',l.max_users,'messagesPerDay',l.messages_per_day,'maxPendingMessages',l.max_pending_messages) AS limits
  FROM organizations o JOIN organization_limits l ON l.organization_id=o.id LEFT JOIN flow_features f ON f.organization_id=o.id LOOP
  INSERT INTO commercial_plans(name,legacy,organization_id) VALUES(item.plan,true,item.id) RETURNING id INTO plan;
  INSERT INTO commercial_plan_versions(plan_id,version,name,limits,flows_enabled,organization_id) VALUES(plan,1,item.plan,item.limits,item.flows_enabled,item.id) RETURNING id INTO version_id;
  INSERT INTO organization_commercial_plans(organization_id,plan_version_id) VALUES(item.id,version_id);
 END LOOP;
END $$;
