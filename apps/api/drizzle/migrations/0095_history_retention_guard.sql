-- Keep uncertain historical writes and private-media obligations until their
-- durable ACK. Expired leases and canceled runs are not proof of non-delivery.
-- This migration changes no data and admits no capture, replay or purge.
CREATE FUNCTION lifecycle_history_pending_count(p_org uuid,p_channel uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT count(*) FROM public.history_sync_deliveries d
 WHERE d.organization_id=p_org AND (p_channel IS NULL OR d.channel_id=p_channel)
  AND (d.state<>'DONE' OR d.receipt->>'state' IS DISTINCT FROM 'PERSISTED')
  AND (d.attempts>0 OR d.lease_token IS NOT NULL OR d.state='WAITING_MEDIA');
$$;
ALTER FUNCTION lifecycle_history_pending_count(uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_history_pending_count(uuid,uuid) FROM PUBLIC,jrc_auth,jrc_app,jrc_platform,jrc_lifecycle;

CREATE FUNCTION lifecycle_assert_history_clear(p_org uuid,p_channel uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 -- Admission already holds the organization/channel fence. Existing deletion
 -- closes new admission. Lock durable obligations before checking their state.
 PERFORM 1 FROM public.history_sync_deliveries d
  WHERE d.organization_id=p_org AND (p_channel IS NULL OR d.channel_id=p_channel)
  ORDER BY d.id FOR UPDATE;
 IF public.lifecycle_history_pending_count(p_org,p_channel)>0 THEN
  RAISE EXCEPTION 'LIFECYCLE_PENDING_WORK' USING ERRCODE='23514',CONSTRAINT='lifecycle_pending_work';
 END IF;
END $$;
ALTER FUNCTION lifecycle_assert_history_clear(uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_assert_history_clear(uuid,uuid) FROM PUBLIC,jrc_auth,jrc_app,jrc_platform,jrc_lifecycle;
--> statement-breakpoint
-- Preserve the existing function identity and all prior pending-work checks.
CREATE OR REPLACE FUNCTION lifecycle_pending_count(p_org uuid,p_channel uuid,p_resource uuid)
RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.lifecycle_pending_count_before_complete_native(p_org,p_channel,p_resource)
  +CASE WHEN p_resource IS NULL OR p_channel IS NOT NULL
   THEN public.lifecycle_native_pending_count(p_org,p_channel)
    +public.lifecycle_history_pending_count(p_org,p_channel) ELSE 0 END;
$$;
ALTER FUNCTION lifecycle_pending_count(uuid,uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_pending_count(uuid,uuid,uuid) FROM PUBLIC,jrc_auth,jrc_app,jrc_platform,jrc_lifecycle;
GRANT EXECUTE ON FUNCTION lifecycle_pending_count(uuid,uuid,uuid) TO jrc_lifecycle;

DO $$ DECLARE original text; patched text; BEGIN
 original=pg_get_functiondef('public.lifecycle_cancel_safe_work(uuid,uuid)'::regprocedure);
 patched=replace(original,'PERFORM public.lifecycle_cancel_safe_work_before_complete_native(p_org,p_channel);',
  'PERFORM public.lifecycle_assert_history_clear(p_org,p_channel);
 PERFORM public.lifecycle_cancel_safe_work_before_complete_native(p_org,p_channel);');
 IF patched=original THEN RAISE EXCEPTION 'HISTORY_RETENTION_ADMISSION_UPGRADE_MISMATCH'; END IF;
 EXECUTE patched;
 original=pg_get_functiondef('public.lifecycle_validate_purge(uuid,uuid,text)'::regprocedure);
 patched=replace(original,'RETURN public.lifecycle_validate_purge_before_complete_native(p_deletion,p_lease,p_kind);',
  'PERFORM public.lifecycle_assert_history_clear(org,channel);
 RETURN public.lifecycle_validate_purge_before_complete_native(p_deletion,p_lease,p_kind);');
 IF patched=original THEN RAISE EXCEPTION 'HISTORY_RETENTION_PURGE_UPGRADE_MISMATCH'; END IF;
 EXECUTE patched;
END $$;
--> statement-breakpoint
-- The coordinator must recheck old REQUESTED jobs before ANY external cleanup,
-- not merely after the remote session or private objects have been removed.
CREATE FUNCTION lifecycle_assert_history_cleanup(p_deletion uuid,p_lease uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.lifecycle_deletions%ROWTYPE; channel uuid;
BEGIN
 IF session_user NOT IN ('jrc_lifecycle','jrc_platform') THEN RAISE EXCEPTION 'LIFECYCLE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT * INTO d FROM public.lifecycle_deletions WHERE id=p_deletion FOR UPDATE;
 IF NOT FOUND OR d.lease_token IS DISTINCT FROM p_lease OR d.lease_expires_at<=clock_timestamp()
   OR d.lease_expires_at IS NULL OR d.status NOT IN ('CLEANING_EXTERNAL','REMOVING_DATA') THEN
  RAISE EXCEPTION 'LIFECYCLE_LEASE_LOST' USING ERRCODE='23514',CONSTRAINT='lifecycle_cleanup_lease';
 END IF;
 IF d.kind='CHANNEL' THEN channel=d.messaging_channel_id; END IF;
 IF d.kind='ORGANIZATION' OR channel IS NOT NULL THEN
  PERFORM public.lifecycle_assert_history_clear(d.organization_id,channel);
 END IF;
 -- A row lock may wait; the original actor and SQL clock still have to permit
 -- cleanup after that wait. The function itself never authorizes a DELETE.
 IF NOT EXISTS(SELECT 1 FROM public.lifecycle_deletions v WHERE v.id=p_deletion AND v.lease_token=p_lease
   AND v.lease_expires_at>clock_timestamp() AND v.status IN ('CLEANING_EXTERNAL','REMOVING_DATA')) THEN
  RAISE EXCEPTION 'LIFECYCLE_LEASE_LOST' USING ERRCODE='23514',CONSTRAINT='lifecycle_cleanup_lease';
 END IF;
 IF NOT (CASE WHEN d.actor_kind='PLATFORM' THEN EXISTS(
  SELECT 1 FROM public.platform_users u WHERE u.id=d.actor_id AND u.role='SUPER_ADMIN' AND u.active)
 ELSE EXISTS(SELECT 1 FROM public.memberships m JOIN public.users u ON u.id=m.user_id
  WHERE m.organization_id=d.organization_id AND m.user_id=d.actor_id AND m.status='ACTIVE'
   AND u.status='ACTIVE' AND m.role IN ('OWNER','ADMIN')) END) THEN
  RAISE EXCEPTION 'LIFECYCLE_ACTOR_REVOKED' USING ERRCODE='42501',CONSTRAINT='lifecycle_cleanup_actor';
 END IF;
END $$;
ALTER FUNCTION lifecycle_assert_history_cleanup(uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_assert_history_cleanup(uuid,uuid) FROM PUBLIC,jrc_auth,jrc_app,jrc_platform,jrc_lifecycle;
GRANT EXECUTE ON FUNCTION lifecycle_assert_history_cleanup(uuid,uuid) TO jrc_lifecycle;
--> statement-breakpoint
-- Enforce the same fence at the real engine and object-store authorization
-- boundaries, including jobs resumed by an older coordinator binary.
DO $$ DECLARE original text; patched text; BEGIN
 original=pg_get_functiondef('public.evolution_cleanup_snapshot(uuid,uuid,uuid,boolean)'::regprocedure);
 patched=replace(original,'IF c.engine_id IS NULL THEN',
  'IF mutating THEN PERFORM public.lifecycle_assert_history_cleanup(deletion,deletion_lease); END IF;
 IF c.engine_id IS NULL THEN');
 IF patched=original THEN RAISE EXCEPTION 'HISTORY_RETENTION_ENGINE_UPGRADE_MISMATCH'; END IF;
 EXECUTE patched;
 original=pg_get_functiondef('public.media_private_delete_authorized()'::regprocedure);
 patched=replace(original,'RETURN NEW;',
  'PERFORM public.lifecycle_assert_history_cleanup(NEW.deletion_id,NEW.authorization_lease);
 RETURN NEW;');
 IF patched=original THEN RAISE EXCEPTION 'HISTORY_RETENTION_PRIVATE_MEDIA_UPGRADE_MISMATCH'; END IF;
 EXECUTE patched;
END $$;
--> statement-breakpoint
-- Existing PREPARED DELETE operations must cross the authorization fence again
-- when claiming their external mutation. UNKNOWN reconciliation and settlement
-- remain read-only/unblocked; only a fresh DISPATCHED lease is guarded.
CREATE TRIGGER media_private_delete_dispatch_guard
 BEFORE UPDATE OF state,lease_token ON media_private_operations
 FOR EACH ROW WHEN(NEW.kind='DELETE' AND NEW.state='DISPATCHED' AND NEW.lease_token IS NOT NULL
  AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.lease_token IS DISTINCT FROM OLD.lease_token))
 EXECUTE FUNCTION media_private_delete_authorized();
