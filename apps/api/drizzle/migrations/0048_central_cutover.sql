CREATE TABLE central_cutover_operations (
 organization_id uuid NOT NULL REFERENCES organizations(id),id uuid NOT NULL DEFAULT gen_random_uuid(),
 actor_id uuid NOT NULL,origin text NOT NULL CHECK(origin ~ '^https://[^/?#@]+$'),account_id bigint NOT NULL CHECK(account_id BETWEEN 1 AND 9007199254740991),
 inbox_id bigint NOT NULL CHECK(inbox_id BETWEEN 1 AND 9007199254740991),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 credential_version integer NOT NULL CHECK(credential_version>0),destination_revision integer NOT NULL CHECK(destination_revision>0),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 webhook_fingerprint text NOT NULL CHECK(webhook_fingerprint ~ '^[a-f0-9]{64}$'),previous_bot_id bigint CHECK(previous_bot_id BETWEEN 1 AND 9007199254740991),
 previous_bot_fingerprint text NOT NULL CHECK(previous_bot_fingerprint ~ '^[a-f0-9]{64}$'),
 bot_id bigint CHECK(bot_id BETWEEN 1 AND 9007199254740991),encrypted_webhook_secret text,
 integration_id uuid NOT NULL,channel_id uuid NOT NULL,legacy_binding_id uuid,legacy_revision integer,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','DISPATCHED','UNKNOWN','COMPLETE','ROLLED_BACK','CANCELED')),
 step text NOT NULL DEFAULT 'DETACH' CHECK(step IN ('DETACH','CREATE','ATTACH','VERIFY')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),lease_token uuid,lease_expires_at timestamptz,
 rollback_step text CHECK(rollback_step IN ('DETACH','RESTORE','VERIFY')),rollback_owner_revision integer CHECK(rollback_owner_revision>=0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id),UNIQUE(organization_id,idempotency_key),
 FOREIGN KEY(organization_id,legacy_binding_id) REFERENCES flow_chatwoot_bindings(organization_id,id),
 FOREIGN KEY(organization_id,origin) REFERENCES chatwoot_destinations(organization_id,base_url),
 CONSTRAINT central_cutover_lease CHECK((status='DISPATCHED')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX central_cutover_remote_claim ON central_cutover_operations(origin,account_id,inbox_id) WHERE status NOT IN ('ROLLED_BACK','CANCELED');
CREATE UNIQUE INDEX central_cutover_active_integration ON central_cutover_operations(organization_id,integration_id) WHERE status NOT IN ('ROLLED_BACK','CANCELED');
ALTER TABLE central_transport_bindings
 ADD COLUMN bot_id bigint CHECK(bot_id BETWEEN 1 AND 9007199254740991),
 ADD COLUMN bot_callback text CHECK(bot_callback ~ '^https://'),
 ADD COLUMN capabilities_observed_at timestamptz,ADD COLUMN callback_verified_at timestamptz,
 ADD COLUMN callback_credential_version integer,ADD COLUMN callback_destination_revision integer;
--> statement-breakpoint
ALTER TABLE central_cutover_operations OWNER TO jrc_migrator;
ALTER TABLE central_cutover_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE central_cutover_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY central_tenant ON central_cutover_operations TO jrc_app
 USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY lifecycle_migrator ON central_cutover_operations TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON central_cutover_operations FROM PUBLIC,jrc_auth,jrc_platform;
GRANT SELECT,INSERT,UPDATE ON central_cutover_operations TO jrc_app;
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('central_cutover_operations');
--> statement-breakpoint
DO $$ DECLARE original text; patched text; BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 patched=replace(original,'DELETE FROM public.central_runtime_events WHERE organization_id=org AND channel_id=channel;',
 'DELETE FROM public.central_cutover_operations WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.central_runtime_events WHERE organization_id=org AND channel_id=channel;');
 IF patched=original THEN RAISE EXCEPTION 'CENTRAL_CUTOVER_PURGE_PATCH_TARGET_MISSING'; END IF;
 EXECUTE patched;
END $$;
--> statement-breakpoint
ALTER FUNCTION lifecycle_pending_count(uuid,uuid,uuid) RENAME TO lifecycle_pending_count_before_central_cutover;
CREATE FUNCTION lifecycle_pending_count(p_org uuid,p_channel uuid,p_resource uuid)
RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.lifecycle_pending_count_before_central_cutover(p_org,p_channel,p_resource)
 +(SELECT count(*) FROM public.central_cutover_operations c WHERE c.organization_id=p_org
 AND (p_channel IS NULL OR c.channel_id=p_channel) AND c.status IN ('PENDING','DISPATCHED','UNKNOWN'));
$$;
ALTER FUNCTION lifecycle_pending_count(uuid,uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_pending_count(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle_pending_count(uuid,uuid,uuid) TO jrc_lifecycle;
