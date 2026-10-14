-- Additive repair: preserve historical 0055-0059 migration bytes and strict runtime roles.
-- Native callback uncertainty must be fenced before admitting catalogue-driven deletion.
CREATE FUNCTION lifecycle_native_pending_count(p_org uuid,p_channel uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT
  (SELECT count(*) FROM public.flow_native_registration_challenges c
   WHERE c.organization_id=p_org AND c.state='VERIFYING'
    AND (p_channel IS NULL OR EXISTS(
     SELECT 1 FROM public.flow_native_registration_targets t
     WHERE t.organization_id=c.organization_id AND t.challenge_id=c.id AND t.channel_id=p_channel)))
  +(SELECT count(*) FROM public.flow_native_installation_operations o
    WHERE o.organization_id=p_org AND o.state IN ('PENDING','VERIFYING','UNKNOWN')
     AND (p_channel IS NULL OR EXISTS(
      SELECT 1 FROM public.flow_native_installation_targets t
      WHERE t.organization_id=o.organization_id AND t.grant_id=o.grant_id AND t.channel_id=p_channel)));
$$;
ALTER FUNCTION lifecycle_native_pending_count(uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_native_pending_count(uuid,uuid) FROM PUBLIC,jrc_auth,jrc_app,jrc_platform,jrc_lifecycle;
--> statement-breakpoint
ALTER FUNCTION lifecycle_pending_count(uuid,uuid,uuid) RENAME TO lifecycle_pending_count_before_complete_native;
CREATE FUNCTION lifecycle_pending_count(p_org uuid,p_channel uuid,p_resource uuid)
RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.lifecycle_pending_count_before_complete_native(p_org,p_channel,p_resource)
  +CASE WHEN p_resource IS NULL OR p_channel IS NOT NULL
   THEN public.lifecycle_native_pending_count(p_org,p_channel) ELSE 0 END;
$$;
ALTER FUNCTION lifecycle_pending_count(uuid,uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_pending_count(uuid,uuid,uuid),
 lifecycle_pending_count_before_complete_native(uuid,uuid,uuid) FROM PUBLIC,jrc_auth,jrc_app,jrc_platform,jrc_lifecycle;
GRANT EXECUTE ON FUNCTION lifecycle_pending_count(uuid,uuid,uuid) TO jrc_lifecycle;
--> statement-breakpoint
-- Admission callers already own the organization/channel locks. Native services
-- acquire the same organization/channel locks before claiming or committing I/O.
-- Never convert UNKNOWN to canceled or infer drain from a local timeout.
ALTER FUNCTION lifecycle_cancel_safe_work(uuid,uuid) RENAME TO lifecycle_cancel_safe_work_before_complete_native;
CREATE FUNCTION lifecycle_cancel_safe_work(p_org uuid,p_channel uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF session_user<>'jrc_platform' THEN
  RAISE EXCEPTION 'LIFECYCLE_FORBIDDEN' USING ERRCODE='42501';
 END IF;
 PERFORM 1 FROM public.flow_native_registration_challenges c
  WHERE c.organization_id=p_org AND (p_channel IS NULL OR EXISTS(
   SELECT 1 FROM public.flow_native_registration_targets t
   WHERE t.organization_id=c.organization_id AND t.challenge_id=c.id AND t.channel_id=p_channel))
  ORDER BY c.id FOR UPDATE;
 PERFORM 1 FROM public.flow_native_installation_operations o
  WHERE o.organization_id=p_org AND (p_channel IS NULL OR EXISTS(
   SELECT 1 FROM public.flow_native_installation_targets t
   WHERE t.organization_id=o.organization_id AND t.grant_id=o.grant_id AND t.channel_id=p_channel))
  ORDER BY o.id FOR UPDATE;
 IF public.lifecycle_native_pending_count(p_org,p_channel)>0 THEN
  RAISE EXCEPTION 'LIFECYCLE_PENDING_WORK' USING ERRCODE='23514',CONSTRAINT='lifecycle_pending_work';
 END IF;
 PERFORM public.lifecycle_cancel_safe_work_before_complete_native(p_org,p_channel);
END $$;
ALTER FUNCTION lifecycle_cancel_safe_work(uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_cancel_safe_work(uuid,uuid),
 lifecycle_cancel_safe_work_before_complete_native(uuid,uuid) FROM PUBLIC,jrc_auth,jrc_app,jrc_platform,jrc_lifecycle;
--> statement-breakpoint
-- Keep the original actor, lease, external cleanup and private-media checks.
-- Recheck native uncertainty at final purge for operations admitted by older code.
ALTER FUNCTION lifecycle_validate_purge(uuid,uuid,text) RENAME TO lifecycle_validate_purge_before_complete_native;
CREATE FUNCTION lifecycle_validate_purge(p_deletion uuid,p_lease uuid,p_kind text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid; channel uuid;
BEGIN
 org=public.lifecycle_validate_purge_before_complete_native(p_deletion,p_lease,p_kind);
 IF p_kind='CHANNEL' THEN
  SELECT messaging_channel_id INTO channel FROM public.lifecycle_deletions WHERE id=p_deletion;
  -- A QR instance without a messaging channel cannot own native target rows.
  IF channel IS NULL THEN RETURN org; END IF;
 END IF;
 PERFORM 1 FROM public.flow_native_registration_challenges c
  WHERE c.organization_id=org AND (channel IS NULL OR EXISTS(
   SELECT 1 FROM public.flow_native_registration_targets t
   WHERE t.organization_id=c.organization_id AND t.challenge_id=c.id AND t.channel_id=channel))
  ORDER BY c.id FOR UPDATE;
 PERFORM 1 FROM public.flow_native_installation_operations o
  WHERE o.organization_id=org AND (channel IS NULL OR EXISTS(
   SELECT 1 FROM public.flow_native_installation_targets t
   WHERE t.organization_id=o.organization_id AND t.grant_id=o.grant_id AND t.channel_id=channel))
  ORDER BY o.id FOR UPDATE;
 IF public.lifecycle_native_pending_count(org,channel)>0 THEN
  RAISE EXCEPTION 'LIFECYCLE_PENDING_WORK' USING ERRCODE='23514',CONSTRAINT='lifecycle_pending_work';
 END IF;
 -- Native row locks can wait: revalidate actor, external cleanup and the SQL
 -- lease clock after those waits, rather than using the earlier authorization.
 RETURN public.lifecycle_validate_purge_before_complete_native(p_deletion,p_lease,p_kind);
END $$;
ALTER FUNCTION lifecycle_validate_purge(uuid,uuid,text) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_validate_purge(uuid,uuid,text),
 lifecycle_validate_purge_before_complete_native(uuid,uuid,text) FROM PUBLIC,jrc_auth,jrc_app,jrc_platform,jrc_lifecycle;
GRANT EXECUTE ON FUNCTION lifecycle_validate_purge(uuid,uuid,text) TO jrc_lifecycle;
--> statement-breakpoint
-- Only this reverse edge is deferred. RESTRICT would still check the DELETE
-- immediately; NO ACTION enforces the same composite reference at commit.
-- lifecycle_purge_organization already defers constraints and orders all
-- remaining nondeferrable edges without bypassing unknown tables or cycles.
ALTER TABLE flow_native_registration_challenges
 DROP CONSTRAINT flow_native_challenge_registration_fk;
ALTER TABLE flow_native_registration_challenges
 ADD CONSTRAINT flow_native_challenge_registration_fk
 FOREIGN KEY(organization_id,registration_id)
 REFERENCES flow_native_registrations(organization_id,id)
 ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES
 ('flow_native_registration_challenges'),
 ('flow_native_registration_targets'),
 ('flow_native_registrations'),
 ('flow_native_installation_grants'),
 ('flow_native_installation_operations'),
 ('flow_native_installation_targets');
