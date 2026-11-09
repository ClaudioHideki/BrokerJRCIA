export const guidedSetupRuntimeSql = `NOT EXISTS(
 SELECT 1 FROM (VALUES ('automation_packages','automation_packages_tenant','automation_packages_scope'),
 ('guided_setup_operations','guided_setup_tenant','guided_setup_scope')) required(name,policy_name,constraint_name)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.'||required.name)
  AND c.relrowsecurity AND c.relforcerowsecurity AND pg_catalog.pg_get_userbyid(c.relowner)='jrc_migrator'
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname=required.policy_name
   AND p.polcmd='*' AND p.polroles=ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='jrc_app')])
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid AND k.conname=required.constraint_name AND k.convalidated)
  AND pg_catalog.has_table_privilege('jrc_app',c.oid,'SELECT')
  AND pg_catalog.has_table_privilege('jrc_app',c.oid,'INSERT')
  AND pg_catalog.has_table_privilege('jrc_app',c.oid,'UPDATE')
  AND NOT pg_catalog.has_table_privilege('jrc_app',c.oid,'DELETE')
  AND NOT pg_catalog.has_table_privilege('jrc_auth',c.oid,'SELECT')
  AND NOT pg_catalog.has_table_privilege('jrc_platform',c.oid,'SELECT')
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a WHERE a.grantee=0)
 ))`;
