-- Register only the new tenant tables in the existing explicitly confirmed
-- deletion path. No retention timer, automatic deletion or replay is enabled.
INSERT INTO lifecycle_purge_catalogue(table_name)
VALUES ('history_source_sessions'),('history_sync_connection_policies');
--> statement-breakpoint
-- Live media uses its own sealed scope. The authorized channel purge must
-- cover both scopes before deleting the session which proves their ownership.
DO $$ DECLARE original text;patched text;needle text;replacement text;BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 needle='SELECT history_scope_key FROM public.history_source_sessions WHERE organization_id=org AND channel_id=channel';
 replacement=needle||' UNION ALL SELECT live_scope_key FROM public.history_source_sessions WHERE organization_id=org AND channel_id=channel';
 IF (length(original)-length(replace(original,needle,'')))/length(needle)<>3 THEN
  RAISE EXCEPTION 'HISTORY_LIFECYCLE_SCOPE_UPGRADE_MISMATCH';
 END IF;
 patched=replace(original,needle,replacement);
 EXECUTE patched;
END $$;
--> statement-breakpoint
-- Organization deletion has its own FK-ordered public-table path. Drain its
-- private source journal before that path removes the scope/session witnesses.
DO $$ DECLARE original text;patched text;needle text;BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_organization(uuid,uuid)'::regprocedure);
 needle='SELECT array_agg(table_name) INTO remaining FROM public.lifecycle_purge_catalogue;';
 patched=replace(original,needle,
 'DELETE FROM jrc_evolution_origin.attempts WHERE event_id IN (SELECT e.id FROM jrc_evolution_origin.events e JOIN public.history_source_sessions s ON s.live_scope_key=e.scope_key WHERE s.organization_id=org);
  DELETE FROM jrc_evolution_origin.events WHERE scope_key IN (SELECT live_scope_key FROM public.history_source_sessions WHERE organization_id=org);
  DELETE FROM jrc_evolution_origin.history_media WHERE (scope_key,capture_id) IN (SELECT scope_key,capture_id FROM jrc_evolution_origin.history_batches WHERE organization_id=org);
  DELETE FROM jrc_evolution_origin.history_chunks WHERE (scope_key,capture_id) IN (SELECT scope_key,capture_id FROM jrc_evolution_origin.history_batches WHERE organization_id=org);
  DELETE FROM jrc_evolution_origin.history_batches WHERE organization_id=org;
  '||needle);
 IF patched=original THEN RAISE EXCEPTION 'HISTORY_LIFECYCLE_ORGANIZATION_UPGRADE_MISMATCH';END IF;
 EXECUTE patched;
END $$;
--> statement-breakpoint
CREATE FUNCTION history_source_lifecycle_ready() RETURNS boolean LANGUAGE sql STABLE
 SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT (SELECT count(*)=2 FROM public.lifecycle_purge_catalogue
  WHERE table_name IN ('history_source_sessions','history_sync_connection_policies'))
  AND (SELECT (length(body)-length(replace(body,needle,'')))/length(needle)=3
   FROM (SELECT pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure) AS body,
    'UNION ALL SELECT live_scope_key FROM public.history_source_sessions WHERE organization_id=org AND channel_id=channel' AS needle) reviewed)
  AND position('DELETE FROM jrc_evolution_origin.history_batches WHERE organization_id=org;'
   in pg_get_functiondef('public.lifecycle_purge_organization(uuid,uuid)'::regprocedure))>0
$$;
REVOKE ALL ON FUNCTION history_source_lifecycle_ready() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION history_source_lifecycle_ready() TO jrc_app;
-- Binary rollback: disable capture, preserve journal/session rows and private
-- objects; keep this additive catalogue/scope correction. Never delete on boot.
