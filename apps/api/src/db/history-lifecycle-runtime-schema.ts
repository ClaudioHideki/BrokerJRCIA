/** Structural admission for history retention before any destructive I/O. */
export const historyLifecycleRuntimeSql = `NOT EXISTS(
 SELECT 1 FROM (VALUES
  ('lifecycle_history_pending_count(uuid,uuid)',false),
  ('lifecycle_assert_history_clear(uuid,uuid)',false),
  ('lifecycle_assert_history_cleanup(uuid,uuid)',true)
 ) required(signature,worker_execute)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
  WHERE p.oid=pg_catalog.to_regprocedure('public.'||required.signature)
   AND p.prosecdef AND pg_catalog.pg_get_userbyid(p.proowner)='jrc_migrator'
   AND p.proconfig @> ARRAY['search_path=pg_catalog, public']
   AND pg_catalog.has_function_privilege('jrc_lifecycle',p.oid,'EXECUTE')=required.worker_execute
   AND NOT pg_catalog.has_function_privilege('jrc_app',p.oid,'EXECUTE')
   AND NOT pg_catalog.has_function_privilege('jrc_auth',p.oid,'EXECUTE')
   AND NOT pg_catalog.has_function_privilege('jrc_platform',p.oid,'EXECUTE')
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=0)
 )) AND NOT EXISTS(
 SELECT 1 FROM (VALUES
  ('lifecycle_pending_count(uuid,uuid,uuid)','lifecycle_history_pending_count'),
  ('lifecycle_cancel_safe_work(uuid,uuid)','lifecycle_assert_history_clear'),
  ('lifecycle_validate_purge(uuid,uuid,text)','lifecycle_assert_history_clear'),
  ('evolution_cleanup_snapshot(uuid,uuid,uuid,boolean)','lifecycle_assert_history_cleanup'),
  ('media_private_delete_authorized()','lifecycle_assert_history_cleanup')
 ) required(signature,guard_name)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
  WHERE p.oid=pg_catalog.to_regprocedure('public.'||required.signature)
   AND p.prosecdef AND pg_catalog.pg_get_userbyid(p.proowner)='jrc_migrator'
   AND p.prosrc LIKE '%'||required.guard_name||'%'
 )) AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
  WHERE t.tgrelid=pg_catalog.to_regclass('public.media_private_operations')
   AND t.tgname='media_private_delete_dispatch_guard' AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal
   AND t.tgfoid=pg_catalog.to_regprocedure('public.media_private_delete_authorized()'))`;
