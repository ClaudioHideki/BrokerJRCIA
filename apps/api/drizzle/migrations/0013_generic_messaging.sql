ALTER TABLE messaging_channels ADD COLUMN provider provider_kind NOT NULL DEFAULT 'META';
ALTER TABLE messaging_channels ADD COLUMN instance_id uuid;
ALTER TABLE messaging_channels ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE messaging_channels ALTER COLUMN waba_id DROP NOT NULL;
ALTER TABLE messaging_channels ADD CONSTRAINT messaging_channels_instance_fk
  FOREIGN KEY (organization_id, instance_id) REFERENCES instances(organization_id,id) ON DELETE RESTRICT;
ALTER TABLE messaging_channels ADD CONSTRAINT messaging_channels_kind_fields CHECK (
  (provider='META' AND instance_id IS NULL AND phone_number_id IS NOT NULL AND waba_id IS NOT NULL)
  OR (provider='BAILEYS' AND instance_id IS NOT NULL AND phone_number_id IS NULL AND waba_id IS NULL)
);
CREATE UNIQUE INDEX messaging_channels_instance_unique ON messaging_channels(organization_id,instance_id) WHERE instance_id IS NOT NULL;
--> statement-breakpoint
-- Resolve a single opaque channel for authenticated ingress, without granting tenant-table scans.
CREATE POLICY messaging_channels_ingress_resolution ON messaging_channels FOR SELECT TO jrc_migrator USING (true);
CREATE FUNCTION resolve_qr_channel(p_channel uuid) RETURNS TABLE(organization_id uuid,instance_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT channel.organization_id,channel.instance_id FROM public.messaging_channels channel
   WHERE channel.id=p_channel AND channel.provider='BAILEYS'
$$;
ALTER FUNCTION resolve_qr_channel(uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION resolve_qr_channel(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_qr_channel(uuid) TO jrc_app;
