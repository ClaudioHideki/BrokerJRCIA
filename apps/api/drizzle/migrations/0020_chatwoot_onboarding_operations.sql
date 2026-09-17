CREATE TABLE chatwoot_onboarding_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES chatwoot_accounts(organization_id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  input_hash text NOT NULL, input jsonb NOT NULL,
  account_id bigint NOT NULL CHECK(account_id>0), destination_revision integer NOT NULL CHECK(destination_revision>0),
  chatwoot_origin text NOT NULL,
  actor_id uuid, actor_api_key_id uuid, external_actor_id text CHECK(length(external_actor_id)<=80),
  state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','RUNNING','FAILED','UNKNOWN','SUCCEEDED')),
  stage text NOT NULL DEFAULT 'INSTANCE' CHECK(stage IN ('INSTANCE','ACTIVATE_CHANNEL','LINK_INBOX','ASSIGN_AGENTS','VERIFY','DONE')),
  instance_id uuid, channel_id uuid, integration_id uuid, inbox_id bigint,
  reconcile_only boolean NOT NULL DEFAULT false, retry_requested boolean NOT NULL DEFAULT false,
  cancel_requested boolean NOT NULL DEFAULT false,
  lease_token uuid, lease_expires_at timestamptz, last_error text CHECK(last_error ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,id), UNIQUE(organization_id,idempotency_key),
  FOREIGN KEY(organization_id,actor_api_key_id) REFERENCES api_keys(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,instance_id) REFERENCES instances(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,integration_id) REFERENCES chatwoot_connections(organization_id,id) ON DELETE RESTRICT,
  CHECK((actor_id IS NULL) <> (actor_api_key_id IS NULL)),
  CHECK((state='RUNNING' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state<>'RUNNING' AND lease_token IS NULL AND lease_expires_at IS NULL))
);
CREATE UNIQUE INDEX chatwoot_onboarding_active_instance ON chatwoot_onboarding_operations(organization_id,instance_id)
  WHERE instance_id IS NOT NULL AND state<>'SUCCEEDED' AND NOT cancel_requested;
CREATE INDEX chatwoot_onboarding_claim ON chatwoot_onboarding_operations(organization_id,state,created_at);
ALTER TABLE chatwoot_onboarding_operations OWNER TO jrc_migrator;
ALTER TABLE chatwoot_onboarding_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatwoot_onboarding_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY chatwoot_onboarding_tenant ON chatwoot_onboarding_operations TO jrc_app
  USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)
  WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
REVOKE ALL ON chatwoot_onboarding_operations FROM PUBLIC,jrc_auth;
GRANT SELECT,INSERT,UPDATE ON chatwoot_onboarding_operations TO jrc_app;
