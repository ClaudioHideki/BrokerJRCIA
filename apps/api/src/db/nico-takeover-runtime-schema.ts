export const nicoTakeoverRuntimeSql = `
 EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.nico_takeover_operations')
  AND c.relrowsecurity AND c.relforcerowsecurity AND pg_catalog.pg_get_userbyid(c.relowner)='jrc_migrator'
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='nico_takeover_tenant' AND p.polcmd='*'
    AND p.polroles=ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='jrc_app')]))
 AND pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass('public.nico_takeover_operations'),'SELECT')
 AND pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass('public.nico_takeover_operations'),'INSERT')
 AND pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass('public.nico_takeover_operations'),'UPDATE')
 AND NOT pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass('public.nico_takeover_operations'),'DELETE')
 AND NOT EXISTS(SELECT 1 FROM (VALUES ('jrc_auth'),('jrc_platform'),('jrc_lifecycle')) r(name)
  WHERE pg_catalog.has_table_privilege(r.name,pg_catalog.to_regclass('public.nico_takeover_operations'),'SELECT'))
 AND NOT EXISTS(SELECT 1 FROM (VALUES ('nico_takeover_one_open'),('nico_takeover_message_once')) r(name)
  WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index WHERE indexrelid=pg_catalog.to_regclass('public.'||r.name) AND indisunique AND indisvalid))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=pg_catalog.to_regclass('public.messaging_conversations')
  AND tgname='nico_takeover_prevent_resume' AND tgenabled='O' AND tgfoid=pg_catalog.to_regprocedure('public.nico_takeover_prevent_resume()'))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=pg_catalog.to_regclass('public.nico_takeover_operations')
  AND tgname='nico_takeover_immutable' AND tgenabled='O')
 AND NOT EXISTS(SELECT 1 FROM (VALUES ('attendance_owners','nico_takeover_freeze_owner'),('automation_bindings','nico_takeover_freeze_binding'),
  ('flow_executor_cutovers','nico_takeover_freeze_cutover'),('flow_chatwoot_bindings','nico_takeover_freeze_remote_binding'),
  ('central_cutover_operations','nico_takeover_freeze_central_cutover')) required(table_name,trigger_name)
  WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=pg_catalog.to_regclass('public.'||required.table_name)
   AND tgname=required.trigger_name AND tgenabled='O' AND tgfoid=pg_catalog.to_regprocedure('public.nico_takeover_freeze_owner()')))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure('public.lifecycle_pending_count_before_nico_takeover(uuid,uuid,uuid)') AND prosecdef)
`;
