CREATE TABLE chatwoot_provisioning (
 organization_id uuid PRIMARY KEY REFERENCES chatwoot_accounts(organization_id) ON DELETE RESTRICT,
 stage text NOT NULL DEFAULT 'ACCOUNT' CHECK(stage IN ('ACCOUNT','USER','ACCESS','VERIFY','DONE')),
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','RUNNING','FAILED','UNKNOWN','READY')),
 encrypted_input text,
 remote_user_id bigint,
 lease_token uuid, lease_expires_at timestamptz,
 last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((state='RUNNING' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
   OR (state<>'RUNNING' AND lease_token IS NULL AND lease_expires_at IS NULL))
);
ALTER TABLE chatwoot_provisioning OWNER TO jrc_migrator;
ALTER TABLE chatwoot_provisioning ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatwoot_provisioning FORCE ROW LEVEL SECURITY;
CREATE POLICY chatwoot_provisioning_tenant ON chatwoot_provisioning TO jrc_app
 USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
REVOKE ALL ON chatwoot_provisioning FROM PUBLIC,jrc_auth;
GRANT SELECT,INSERT,UPDATE ON chatwoot_provisioning TO jrc_app;
REVOKE UPDATE ON integration_audit FROM jrc_app;
