-- No remote write is replayable from this ledger. UNKNOWN survives worker restarts,
-- revocation and lifecycle requests until canonical evidence establishes the result.
ALTER TABLE automation_outbox ADD CONSTRAINT native_handoff_outbox_execution_unique UNIQUE(organization_id,id,execution_id);
CREATE TABLE attendance_handoff_operations (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
 outbox_id uuid NOT NULL, execution_id uuid NOT NULL, channel_id uuid NOT NULL, conversation_id uuid NOT NULL,
 integration_id uuid, lease_token uuid NOT NULL,
 snapshot jsonb,
 phase text NOT NULL DEFAULT 'PREPARED' CHECK(phase IN ('PREPARED','OPEN_DISPATCHED','OPENED','ASSIGNMENT_DISPATCHED','CONFIRMED')),
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','APPLIED','UNKNOWN','ACTION_REQUIRED')),
 confirmed_by text CHECK(confirmed_by IN ('DISPATCH_READBACK','CANONICAL_RECONCILIATION')),
 last_error text CHECK(last_error IS NULL OR length(last_error) BETWEEN 1 AND 120),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 next_check_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,outbox_id),
 FOREIGN KEY(organization_id,outbox_id,execution_id) REFERENCES automation_outbox(organization_id,id,execution_id),
 FOREIGN KEY(organization_id,channel_id,conversation_id) REFERENCES messaging_conversations(organization_id,channel_id,id),
 FOREIGN KEY(organization_id,channel_id,integration_id) REFERENCES chatwoot_connections(organization_id,channel_id,id),
 CONSTRAINT native_handoff_snapshot_scope CHECK(snapshot IS NULL OR (jsonb_typeof(snapshot)='object'
   AND snapshot#>>'{scope,organizationId}'=organization_id::text AND snapshot#>>'{scope,channelId}'=channel_id::text
   AND snapshot#>>'{scope,integrationId}'=integration_id::text) IS TRUE),
 CONSTRAINT native_handoff_snapshot_required CHECK((snapshot IS NOT NULL AND integration_id IS NOT NULL)
   OR (snapshot IS NULL AND integration_id IS NULL AND state='ACTION_REQUIRED' AND phase='PREPARED')),
 CONSTRAINT native_handoff_applied_phase CHECK((state='APPLIED')=(phase='CONFIRMED') AND (state='APPLIED')=(confirmed_by IS NOT NULL))
);
CREATE INDEX native_handoff_reconciliation ON attendance_handoff_operations(organization_id,next_check_at,id)
 WHERE state IN ('PENDING','UNKNOWN');
ALTER TABLE attendance_handoff_operations OWNER TO jrc_migrator;
ALTER TABLE attendance_handoff_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_handoff_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY attendance_tenant ON attendance_handoff_operations TO jrc_app
 USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY lifecycle_migrator ON attendance_handoff_operations TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON attendance_handoff_operations FROM PUBLIC,jrc_auth,jrc_platform,jrc_lifecycle;
GRANT SELECT,INSERT,UPDATE ON attendance_handoff_operations TO jrc_app;
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('attendance_handoff_operations');
--> statement-breakpoint
DO $$ DECLARE original text; patched text; BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 patched=replace(original,'DELETE FROM public.chatwoot_attendance_observations WHERE organization_id=org AND channel_id=channel;',
  'DELETE FROM public.attendance_handoff_operations WHERE organization_id=org AND channel_id=channel;
   DELETE FROM public.chatwoot_attendance_observations WHERE organization_id=org AND channel_id=channel;');
 IF patched=original THEN RAISE EXCEPTION 'NATIVE_HANDOFF_PURGE_UPGRADE_MISMATCH'; END IF;
 EXECUTE patched;
END $$;
ALTER FUNCTION lifecycle_pending_count(uuid,uuid,uuid) RENAME TO lifecycle_pending_count_before_native_handoff;
CREATE FUNCTION lifecycle_pending_count(p_org uuid,p_channel uuid,p_resource uuid)
RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.lifecycle_pending_count_before_native_handoff(p_org,p_channel,p_resource)
  +(SELECT count(*) FROM public.attendance_handoff_operations h WHERE h.organization_id=p_org
    AND (p_channel IS NULL OR h.channel_id=p_channel) AND h.state IN ('PENDING','UNKNOWN'));
$$;
ALTER FUNCTION lifecycle_pending_count(uuid,uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_pending_count(uuid,uuid,uuid) FROM PUBLIC;
