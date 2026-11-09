/** Read-only structural admission for the immutable, tenant-private routing profiles. */
export const boxRoutingRuntimeSql = `NOT EXISTS(
 SELECT 1 FROM (VALUES ('automation_box_profile_versions',false),('automation_box_profile_heads',true)) required(name,mutable)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.'||required.name)
  AND c.relrowsecurity AND c.relforcerowsecurity AND pg_catalog.pg_get_userbyid(c.relowner)='jrc_migrator'
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='box_profile_tenant'
   AND p.polcmd='*' AND p.polroles=ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='jrc_app')])
  AND pg_catalog.has_table_privilege('jrc_app',c.oid,'SELECT')
  AND pg_catalog.has_table_privilege('jrc_app',c.oid,'INSERT')
  AND pg_catalog.has_table_privilege('jrc_app',c.oid,'UPDATE')=required.mutable
  AND NOT pg_catalog.has_table_privilege('jrc_app',c.oid,'DELETE')
  AND NOT pg_catalog.has_table_privilege('jrc_auth',c.oid,'SELECT')
  AND NOT pg_catalog.has_table_privilege('jrc_platform',c.oid,'SELECT')
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a WHERE a.grantee=0)
 )) AND NOT EXISTS(
 SELECT 1 FROM (VALUES ('automation_box_profile_versions','automation_box_profile_immutable'),
 ('automation_box_profile_versions','lifecycle_box_profile_version_block'),
 ('automation_box_profile_heads','lifecycle_box_profile_head_block')) required(name,trigger_name)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=pg_catalog.to_regclass('public.'||required.name)
  AND t.tgname=required.trigger_name AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal)
 )`;
