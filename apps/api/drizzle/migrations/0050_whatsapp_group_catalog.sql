-- QR G1 is a local catalog and explicit selection of observed metadata.
-- It creates no recipient, conversation, send permission or automation job.
CREATE TABLE whatsapp_group_catalogs (
 organization_id uuid NOT NULL REFERENCES organizations(id),channel_id uuid NOT NULL,
 identity_revision bigint NOT NULL DEFAULT 1 CHECK(identity_revision>0),
 identity_fingerprint text CHECK(identity_fingerprint ~ '^[a-f0-9]{64}$'),
 catalog_revision bigint NOT NULL DEFAULT 0 CHECK(catalog_revision>=0),
 snapshot_id uuid,observed_at timestamptz,valid_until timestamptz,
 last_attempt_at timestamptz NOT NULL DEFAULT now(),last_error_code text CHECK(last_error_code IN (
  'PROVIDER_ABORTED','PROVIDER_TIMEOUT','PROVIDER_REQUEST_FAILED','PROVIDER_INVALID_RESPONSE','IDENTITY_CHANGED','LEASE_LOST'
 )),
 lease_token uuid,lease_expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,channel_id),
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id),
 CONSTRAINT whatsapp_group_catalog_snapshot CHECK(
  (snapshot_id IS NULL AND observed_at IS NULL AND valid_until IS NULL AND identity_fingerprint IS NULL AND catalog_revision=0)
  OR (snapshot_id IS NOT NULL AND observed_at IS NOT NULL AND valid_until IS NOT NULL
   AND identity_fingerprint IS NOT NULL AND catalog_revision>0 AND valid_until>observed_at)
 ),
 CONSTRAINT whatsapp_group_catalog_lease CHECK((lease_token IS NULL)=(lease_expires_at IS NULL))
);
CREATE TABLE whatsapp_group_catalog_items (
 organization_id uuid NOT NULL,channel_id uuid NOT NULL,
 group_jid text NOT NULL CHECK(length(group_jid)<=128 AND group_jid ~ '^[0-9]+(-[0-9]+)?@g[.]us$'),
 subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 256 AND length(btrim(subject))>0),
 participant_count integer NOT NULL CHECK(participant_count BETWEEN 0 AND 100000),
 restrict boolean,announce boolean,is_community boolean,is_community_announce boolean,
 linked_parent text CHECK(linked_parent IS NULL OR (length(linked_parent)<=128 AND linked_parent ~ '^[0-9]+(-[0-9]+)?@g[.]us$')),
 selected boolean NOT NULL DEFAULT false,
 automation_enabled boolean NOT NULL DEFAULT false CHECK(NOT automation_enabled),
 PRIMARY KEY(organization_id,channel_id,group_jid),
 FOREIGN KEY(organization_id,channel_id) REFERENCES whatsapp_group_catalogs(organization_id,channel_id)
);
-- The 2000-item cap is enforced by whole-snapshot admission in the service;
-- no table count or invented provider pagination can establish completeness.
--> statement-breakpoint
ALTER TABLE whatsapp_group_catalogs OWNER TO jrc_migrator;
ALTER TABLE whatsapp_group_catalog_items OWNER TO jrc_migrator;
ALTER TABLE whatsapp_group_catalogs ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_group_catalogs FORCE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_group_catalog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_group_catalog_items FORCE ROW LEVEL SECURITY;
CREATE POLICY group_catalog_tenant ON whatsapp_group_catalogs TO jrc_app
 USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY group_catalog_tenant ON whatsapp_group_catalog_items TO jrc_app
 USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY lifecycle_migrator ON whatsapp_group_catalogs TO jrc_migrator USING(true) WITH CHECK(true);
CREATE POLICY lifecycle_migrator ON whatsapp_group_catalog_items TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON whatsapp_group_catalogs,whatsapp_group_catalog_items FROM PUBLIC,jrc_auth,jrc_platform;
GRANT SELECT,INSERT,UPDATE ON whatsapp_group_catalogs TO jrc_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON whatsapp_group_catalog_items TO jrc_app;
-- A pre-fence channel resolution cannot admit a new catalog/item afterward.
-- UPDATE remains available for lease cleanup; the service serializes and
-- revalidates publish/selection under the existing instance/channel locks.
CREATE TRIGGER lifecycle_whatsapp_group_catalogs_block BEFORE INSERT ON whatsapp_group_catalogs
 FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_channel_write();
CREATE TRIGGER lifecycle_whatsapp_group_catalog_items_block BEFORE INSERT ON whatsapp_group_catalog_items
 FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_channel_write();
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('whatsapp_group_catalogs'),('whatsapp_group_catalog_items');
--> statement-breakpoint
DO $$ DECLARE original text; patched text; BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 patched=replace(original,'DELETE FROM public.messaging_channels WHERE organization_id=org AND id=channel;',
 'DELETE FROM public.whatsapp_group_catalog_items WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.whatsapp_group_catalogs WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.messaging_channels WHERE organization_id=org AND id=channel;');
 IF patched=original THEN RAISE EXCEPTION 'WHATSAPP_GROUP_CATALOG_PURGE_PATCH_TARGET_MISSING'; END IF;
 EXECUTE patched;
END $$;
