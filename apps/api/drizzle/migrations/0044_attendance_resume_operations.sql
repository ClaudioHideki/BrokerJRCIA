ALTER TABLE messaging_conversations ADD COLUMN attendance_revision integer NOT NULL DEFAULT 0 CHECK(attendance_revision>=0);
CREATE TABLE attendance_resume_operations (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), channel_id uuid NOT NULL, conversation_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 request_hash text NOT NULL CHECK(length(request_hash)=64), snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','APPLIED','UNKNOWN','ACTION_REQUIRED','CANCELED')),
 phase text NOT NULL DEFAULT 'PREPARED' CHECK(phase IN ('PREPARED','CLEAR_AGENT','CLEAR_TEAM','PENDING_STATUS','READBACK','CONFIRMED')),
 session_id uuid, last_error text CHECK(last_error IS NULL OR length(last_error) BETWEEN 1 AND 120),
 lease_token uuid, lease_expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,idempotency_key),
 FOREIGN KEY(organization_id,channel_id,conversation_id) REFERENCES messaging_conversations(organization_id,channel_id,id),
 FOREIGN KEY(organization_id,session_id) REFERENCES attendance_sessions(organization_id,id),
 CHECK((state='APPLIED')=(phase='CONFIRMED')),
 CHECK((state='APPLIED')=(session_id IS NOT NULL)),
 CHECK((snapshot->>'channelId'=channel_id::text AND snapshot->>'conversationId'=conversation_id::text) IS TRUE)
);
CREATE UNIQUE INDEX attendance_one_resume ON attendance_resume_operations(organization_id,conversation_id)
 WHERE state IN ('PENDING','UNKNOWN') OR (state='ACTION_REQUIRED' AND phase<>'PREPARED');
ALTER TABLE attendance_resume_operations OWNER TO jrc_migrator;
ALTER TABLE attendance_resume_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_resume_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY attendance_tenant ON attendance_resume_operations TO jrc_app
 USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY lifecycle_migrator ON attendance_resume_operations TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON attendance_resume_operations FROM PUBLIC,jrc_auth,jrc_platform,jrc_lifecycle;
GRANT SELECT,INSERT,UPDATE ON attendance_resume_operations TO jrc_app;
-- App has no direct users grant. Expose only current-tenant authorization, never identity data.
CREATE FUNCTION attendance_resume_actor_allowed(p_actor uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.memberships m JOIN public.users u ON u.id=m.user_id
   WHERE m.organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid
     AND m.user_id=p_actor AND m.role IN ('OWNER','ADMIN') AND m.status='ACTIVE' AND u.status='ACTIVE');
$$;
ALTER FUNCTION attendance_resume_actor_allowed(uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION attendance_resume_actor_allowed(uuid) FROM PUBLIC,jrc_auth,jrc_platform,jrc_lifecycle;
GRANT EXECUTE ON FUNCTION attendance_resume_actor_allowed(uuid) TO jrc_app;
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('attendance_resume_operations');
--> statement-breakpoint
DO $$ DECLARE original text; patched text; BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 patched=replace(original,'DELETE FROM public.attendance_handoff_operations WHERE organization_id=org AND channel_id=channel;',
 'DELETE FROM public.attendance_resume_operations WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.attendance_handoff_operations WHERE organization_id=org AND channel_id=channel;');
 IF patched=original THEN RAISE EXCEPTION 'ATTENDANCE_RESUME_PURGE_UPGRADE_MISMATCH'; END IF;
 EXECUTE patched;
END $$;
ALTER FUNCTION lifecycle_pending_count(uuid,uuid,uuid) RENAME TO lifecycle_pending_count_before_attendance_resume;
CREATE FUNCTION lifecycle_pending_count(p_org uuid,p_channel uuid,p_resource uuid)
RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.lifecycle_pending_count_before_attendance_resume(p_org,p_channel,p_resource)
  +(SELECT count(*) FROM public.attendance_resume_operations r WHERE r.organization_id=p_org
    AND (p_channel IS NULL OR r.channel_id=p_channel)
    AND (r.state IN ('PENDING','UNKNOWN') OR (r.state='ACTION_REQUIRED' AND r.phase<>'PREPARED')));
$$;
ALTER FUNCTION lifecycle_pending_count(uuid,uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_pending_count(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle_pending_count(uuid,uuid,uuid) TO jrc_lifecycle;
--> statement-breakpoint
-- Internal guard used under the existing organization/channel admission locks.
CREATE FUNCTION lifecycle_assert_no_attendance_resume(p_org uuid,p_channel uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM 1 FROM public.attendance_resume_operations
   WHERE organization_id=p_org AND (p_channel IS NULL OR channel_id=p_channel) ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.attendance_resume_operations
   WHERE organization_id=p_org AND (p_channel IS NULL OR channel_id=p_channel)
     AND (state IN ('PENDING','UNKNOWN') OR (state='ACTION_REQUIRED' AND phase<>'PREPARED'))) THEN
   RAISE EXCEPTION 'LIFECYCLE_PENDING_WORK' USING ERRCODE='23514',CONSTRAINT='lifecycle_pending_work';
 END IF;
END $$;
ALTER FUNCTION lifecycle_assert_no_attendance_resume(uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_assert_no_attendance_resume(uuid,uuid) FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
DO $$ DECLARE original text; patched text; BEGIN
 original=pg_get_functiondef('public.lifecycle_cancel_safe_work(uuid,uuid)'::regprocedure);
 patched=replace(original,'-- Serialize with workers that claim existing rows using SKIP LOCKED/row updates.',
 'PERFORM public.lifecycle_assert_no_attendance_resume(p_org,p_channel);
 -- Serialize with workers that claim existing rows using SKIP LOCKED/row updates.');
 IF patched=original THEN RAISE EXCEPTION 'ATTENDANCE_RESUME_CANCEL_GUARD_UPGRADE_MISMATCH'; END IF;
 EXECUTE patched;
 original=pg_get_functiondef('public.lifecycle_validate_purge(uuid,uuid,text)'::regprocedure);
 patched=replace(original,'RETURN op.organization_id;',
 'PERFORM 1 FROM public.organizations WHERE id=op.organization_id FOR UPDATE;
 PERFORM public.lifecycle_assert_no_attendance_resume(op.organization_id,CASE WHEN op.kind=''CHANNEL'' THEN op.messaging_channel_id ELSE NULL END);
 RETURN op.organization_id;');
 IF patched=original THEN RAISE EXCEPTION 'ATTENDANCE_RESUME_PURGE_GUARD_UPGRADE_MISMATCH'; END IF;
 EXECUTE patched;
END $$;
