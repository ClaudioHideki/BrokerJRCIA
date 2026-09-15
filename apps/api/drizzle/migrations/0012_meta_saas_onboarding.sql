CREATE TABLE meta_signup_states (
 state_hash text PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 user_id uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE TABLE meta_connections (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 channel_id uuid NOT NULL, waba_id text NOT NULL, phone_number_id text NOT NULL UNIQUE,
 encrypted_token text, token_expires_at timestamptz, graph_version text NOT NULL,
 status text NOT NULL CHECK(status IN ('PENDING','READY','REVOKED')),
 pending jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (organization_id,channel_id) REFERENCES messaging_channels(organization_id,id),
 CHECK ((status = 'REVOKED') = (encrypted_token IS NULL))
);
ALTER TABLE meta_signup_states OWNER TO jrc_migrator;
ALTER TABLE meta_connections OWNER TO jrc_migrator;
ALTER TABLE meta_signup_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_signup_states FORCE ROW LEVEL SECURITY;
ALTER TABLE meta_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY meta_signup_states_tenant ON meta_signup_states TO jrc_app USING
 (organization_id = NULLIF(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY meta_connections_tenant ON meta_connections TO jrc_app USING
 (organization_id = NULLIF(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY meta_connections_lookup ON meta_connections FOR SELECT TO jrc_migrator USING (true);
REVOKE ALL ON meta_signup_states,meta_connections FROM PUBLIC,jrc_auth;
GRANT SELECT,INSERT,UPDATE,DELETE ON meta_signup_states,meta_connections TO jrc_app;
--> statement-breakpoint
-- Webhook routing discloses only the binding, never a token or customer content.
CREATE FUNCTION resolve_meta_asset(phone text,waba text)
RETURNS TABLE(organization_id uuid,channel_id uuid) LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog,public AS $$
 SELECT organization_id,channel_id FROM public.meta_connections
 WHERE phone_number_id=phone AND waba_id=waba
$$;
ALTER FUNCTION resolve_meta_asset(text,text) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION resolve_meta_asset(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_meta_asset(text,text) TO jrc_app;
--> statement-breakpoint
CREATE FUNCTION resolve_meta_waba(waba text)
RETURNS TABLE(organization_id uuid,id uuid) LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog,public AS $$
 SELECT organization_id,id FROM public.meta_connections WHERE waba_id=waba
$$;
ALTER FUNCTION resolve_meta_waba(text) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION resolve_meta_waba(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_meta_waba(text) TO jrc_app;
