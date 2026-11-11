/** Read-only admission: private V2 staging is optional at runtime, but its
 * candidate binary must not claim the new schema without its isolation guards.
 */
export const historySyncRuntimeSql = `NOT EXISTS(
 SELECT 1 FROM (VALUES ('history_account_identities',false),('history_sync_runs',true),
 ('history_sync_chunks',true),('history_sync_receipts',false)) required(name,mutable)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.'||required.name)
  AND c.relrowsecurity AND c.relforcerowsecurity AND pg_catalog.pg_get_userbyid(c.relowner)='jrc_migrator'
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='history_sync_tenant'
   AND p.polcmd='*' AND p.polroles=ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='jrc_app')])
  AND pg_catalog.has_table_privilege('jrc_app',c.oid,'SELECT') AND pg_catalog.has_table_privilege('jrc_app',c.oid,'INSERT')
  AND pg_catalog.has_table_privilege('jrc_app',c.oid,'UPDATE')=required.mutable
  AND NOT pg_catalog.has_table_privilege('jrc_app',c.oid,'DELETE')
  AND NOT pg_catalog.has_table_privilege('jrc_auth',c.oid,'SELECT')
  AND NOT pg_catalog.has_table_privilege('jrc_platform',c.oid,'SELECT')
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a WHERE a.grantee=0)
 )) AND EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
 WHERE a.attrelid=pg_catalog.to_regclass('public.history_sync_chunks') AND a.attname='admission_kind' AND a.attnotnull AND NOT a.attisdropped)
 AND NOT EXISTS(SELECT 1 FROM (VALUES ('history_sync_runs','history_sync_run_guard'),
 ('history_sync_chunks','history_sync_chunk_guard'),('history_account_identities','history_sync_identity_immutable')) required(name,trigger_name)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=pg_catalog.to_regclass('public.'||required.name)
 AND t.tgname=required.trigger_name AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal))`;
