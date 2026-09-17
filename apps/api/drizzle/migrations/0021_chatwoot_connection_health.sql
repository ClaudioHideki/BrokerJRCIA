ALTER TABLE chatwoot_connections ADD CONSTRAINT chatwoot_connections_channel_binding_unique UNIQUE(organization_id,id,channel_id);
CREATE TABLE chatwoot_connection_health (
  organization_id uuid NOT NULL, integration_id uuid NOT NULL, channel_id uuid NOT NULL,
  identity_enforced boolean NOT NULL DEFAULT false,
  approved_fingerprint text, observed_fingerprint text, observed_last4 text CHECK(observed_last4 ~ '^\d{4}$'),
  identity_revision integer NOT NULL DEFAULT 1 CHECK(identity_revision>0),
  observed_connected boolean NOT NULL DEFAULT false, observed_at timestamptz,
  identity_error text, access_error text,
  pair_window_key uuid, pair_window_expires_at timestamptz,
  callback_verified_at timestamptz, callback_destination_revision integer, callback_credential_version integer,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,integration_id), UNIQUE(organization_id,channel_id),
  FOREIGN KEY(organization_id,integration_id,channel_id) REFERENCES chatwoot_connections(organization_id,id,channel_id) ON DELETE RESTRICT
);
ALTER TABLE chatwoot_connection_health OWNER TO jrc_migrator;
ALTER TABLE chatwoot_connection_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatwoot_connection_health FORCE ROW LEVEL SECURITY;
CREATE POLICY chatwoot_connection_health_tenant ON chatwoot_connection_health TO jrc_app
  USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)
  WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
REVOKE ALL ON chatwoot_connection_health FROM PUBLIC,jrc_auth;
GRANT SELECT,INSERT,UPDATE ON chatwoot_connection_health TO jrc_app;
--> statement-breakpoint
-- Invoker privileges/RLS: flags can hide controls without bypassing identity protection already enabled.
CREATE FUNCTION chatwoot_channel_identity_ready(p_org uuid,p_channel uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT NOT EXISTS(SELECT 1 FROM public.chatwoot_connection_health h WHERE h.organization_id=p_org AND h.channel_id=p_channel AND h.identity_enforced
    AND (h.approved_fingerprint IS NULL OR h.observed_fingerprint IS DISTINCT FROM h.approved_fingerprint OR NOT h.observed_connected OR h.identity_error IS NOT NULL))
$$;
ALTER FUNCTION chatwoot_channel_identity_ready(uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION chatwoot_channel_identity_ready(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chatwoot_channel_identity_ready(uuid,uuid) TO jrc_app;
