ALTER TABLE automation_definitions ADD COLUMN origin text NOT NULL DEFAULT 'NATIVE'
 CHECK(origin IN ('NATIVE','BROKER_FLOW_V1','JRC_CONVERSAS'));
ALTER TABLE automation_definitions ADD COLUMN external_id text;
ALTER TABLE automation_definitions ADD COLUMN migration_status text NOT NULL DEFAULT 'NATIVE'
 CHECK(migration_status IN ('NATIVE','CONVERTED','WAITING_FOR_DRAIN','MANAGED','LEGACY','ROLLED_BACK'));
CREATE UNIQUE INDEX automation_definition_external_origin ON automation_definitions(organization_id,origin,external_id) WHERE external_id IS NOT NULL;
CREATE TABLE automation_legacy_migrations (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
 source text NOT NULL CHECK(source IN ('BROKER_FLOW_V1','JRC_CONVERSAS')), source_id text NOT NULL,
 automation_id uuid, source_version integer, source_checksum text CHECK(source_checksum IS NULL OR source_checksum ~ '^[a-f0-9]{64}$'),
 target_checksum text CHECK(target_checksum IS NULL OR target_checksum ~ '^[a-f0-9]{64}$'),
 status text NOT NULL CHECK(status IN ('CONVERTED','WAITING_FOR_DRAIN','MANAGED','LEGACY','CONFLICT','ROLLED_BACK')),
 binding_count integer NOT NULL DEFAULT 0 CHECK(binding_count>=0), live_execution_count integer NOT NULL DEFAULT 0 CHECK(live_execution_count>=0),
 report jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,source,source_id),
 FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,automation_id) REFERENCES automation_definitions(organization_id,id),
 CHECK(octet_length(report::text)<=131072)
);
CREATE TABLE automation_owner_transitions (
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),channel_id uuid NOT NULL,
 from_origin text NOT NULL CHECK(from_origin IN ('jrc-flows-native','jrc-automation-v2')),
 to_origin text NOT NULL CHECK(to_origin IN ('jrc-flows-native','jrc-automation-v2')),
 automation_id uuid,actor_id uuid,
 reason_code text NOT NULL CHECK(octet_length(reason_code) BETWEEN 1 AND 128),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,id),
 FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id),
 FOREIGN KEY(organization_id,automation_id) REFERENCES automation_definitions(organization_id,id)
);
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['automation_legacy_migrations','automation_owner_transitions'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO jrc_migrator',t);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY automation_migration_tenant ON %I TO jrc_app USING (organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth,jrc_platform',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON automation_legacy_migrations TO jrc_app;
GRANT SELECT,INSERT ON automation_owner_transitions TO jrc_app;
GRANT UPDATE(origin,external_id,migration_status) ON automation_definitions TO jrc_app;
--> statement-breakpoint
CREATE POLICY legacy_flow_discovery ON flows FOR SELECT TO jrc_migrator USING(true);
--> statement-breakpoint
CREATE FUNCTION legacy_flow_migration_organizations(after_id uuid DEFAULT NULL,batch_size integer DEFAULT 100)
RETURNS TABLE(organization_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT f.organization_id FROM public.flows f
 WHERE (after_id IS NULL OR f.organization_id>after_id)
 ORDER BY f.organization_id LIMIT LEAST(GREATEST(batch_size,1),1000)
$$;
ALTER FUNCTION legacy_flow_migration_organizations(uuid,integer) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION legacy_flow_migration_organizations(uuid,integer) FROM PUBLIC,jrc_auth,jrc_platform;
GRANT EXECUTE ON FUNCTION legacy_flow_migration_organizations(uuid,integer) TO jrc_app;
