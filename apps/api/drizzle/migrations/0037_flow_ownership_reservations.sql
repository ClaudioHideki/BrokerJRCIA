-- A committed reservation protects inbox ownership while HTTP runs without row locks.
ALTER TABLE flow_chatwoot_bindings
 ADD COLUMN operation_revision integer NOT NULL DEFAULT 1 CHECK(operation_revision>0),
 ADD COLUMN operation_token uuid,
 ADD COLUMN operation_expires_at timestamptz,
 ADD COLUMN operation_state text NOT NULL DEFAULT 'IDLE',
 ADD CONSTRAINT flow_binding_operation_state CHECK(operation_state IN ('IDLE','RESERVED','DISPATCHED','UNKNOWN')),
 ADD CONSTRAINT flow_binding_operation_lease CHECK(
   (operation_state='IDLE' AND operation_token IS NULL AND operation_expires_at IS NULL)
   OR (operation_state IN ('RESERVED','DISPATCHED') AND operation_token IS NOT NULL AND operation_expires_at IS NOT NULL)
   OR operation_state='UNKNOWN');
-- Old interrupted operations must be observed, not replayed after upgrade.
UPDATE flow_chatwoot_bindings SET operation_state='UNKNOWN' WHERE status IN ('PENDING','UNKNOWN');
ALTER TABLE attendance_owners ADD COLUMN remote_binding_id uuid,
 ADD CONSTRAINT attendance_owner_remote_binding_fk FOREIGN KEY(organization_id,remote_binding_id)
   REFERENCES flow_chatwoot_bindings(organization_id,id),
 ADD CONSTRAINT attendance_owner_remote_binding_kind CHECK(remote_binding_id IS NULL OR (executor='BROKER' AND automation_id IS NULL));
UPDATE attendance_owners ao SET executor='BROKER',automation_id=null,version=null,remote_binding_id=b.id,revision=ao.revision+1
 FROM chatwoot_connections c JOIN flow_chatwoot_bindings b ON b.organization_id=c.organization_id AND b.inbox_id=c.inbox_id AND b.status<>'DISABLED'
 JOIN messaging_channels mc ON mc.organization_id=c.organization_id AND mc.id=c.channel_id
 WHERE ao.organization_id=c.organization_id AND ao.channel_id=c.channel_id AND mc.bot_public_id IS NULL;
--> statement-breakpoint
-- Retain uncertain provisioning even when creation returned no remote bot ID.
ALTER FUNCTION lifecycle_pending_count(uuid,uuid,uuid) RENAME TO lifecycle_pending_count_before_flow_reservation;
CREATE FUNCTION lifecycle_pending_count(p_org uuid,p_channel uuid,p_resource uuid)
RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.lifecycle_pending_count_before_flow_reservation(p_org,p_channel,p_resource)
  +(SELECT count(*) FROM public.flow_chatwoot_bindings b LEFT JOIN public.chatwoot_connections c
     ON c.organization_id=b.organization_id AND c.inbox_id=b.inbox_id
     WHERE b.organization_id=p_org AND b.bot_id IS NULL AND b.operation_state IN ('RESERVED','DISPATCHED','UNKNOWN')
      AND (p_channel IS NULL OR c.channel_id=p_channel) AND (p_resource IS NULL OR c.channel_id=p_channel));
$$;
ALTER FUNCTION lifecycle_pending_count(uuid,uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_pending_count(uuid,uuid,uuid) FROM PUBLIC;
