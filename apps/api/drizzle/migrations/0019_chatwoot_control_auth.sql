CREATE TABLE chatwoot_control_bindings (
  api_key_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES chatwoot_accounts(organization_id) ON DELETE RESTRICT,
  account_id bigint NOT NULL CHECK(account_id>0),
  destination_revision integer NOT NULL CHECK(destination_revision>0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,api_key_id) REFERENCES api_keys(organization_id,id) ON DELETE CASCADE
);
CREATE TABLE chatwoot_operator_grants (
  organization_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  user_id uuid NOT NULL,
  can_pair boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,integration_id,user_id),
  FOREIGN KEY(organization_id,integration_id) REFERENCES chatwoot_connections(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,user_id) REFERENCES memberships(organization_id,user_id) ON DELETE CASCADE
);
ALTER TABLE integration_audit ADD COLUMN actor_api_key_id uuid;
ALTER TABLE integration_audit ADD COLUMN external_actor_id text CHECK(length(external_actor_id)<=80);
ALTER TABLE integration_audit ADD CONSTRAINT integration_audit_control_actor_fk
  FOREIGN KEY(organization_id,actor_api_key_id) REFERENCES api_keys(organization_id,id) ON DELETE RESTRICT;
--> statement-breakpoint
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['chatwoot_control_bindings','chatwoot_operator_grants'] LOOP
    EXECUTE format('ALTER TABLE %I OWNER TO jrc_migrator',tab);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY %I ON %I TO jrc_app USING(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',tab||'_tenant',tab);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth',tab);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO jrc_app',tab);
  END LOOP;
END $$;
CREATE FUNCTION revoke_chatwoot_control_binding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL THEN
    UPDATE public.chatwoot_control_bindings SET active=false WHERE organization_id=NEW.organization_id AND api_key_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION revoke_chatwoot_control_binding() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION revoke_chatwoot_control_binding() FROM PUBLIC;
CREATE TRIGGER api_key_chatwoot_revocation AFTER UPDATE OF revoked_at ON api_keys
  FOR EACH ROW EXECUTE FUNCTION revoke_chatwoot_control_binding();
