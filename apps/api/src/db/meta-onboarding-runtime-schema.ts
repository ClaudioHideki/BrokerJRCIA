export const metaOnboardingRuntimeSql=`
 EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass('public.meta_connections')
  AND attname='readiness_revision' AND attnotnull AND NOT attisdropped)
 AND
 NOT EXISTS(SELECT 1 FROM (VALUES ('meta_waba_ownership'),('meta_management_events')) AS required(name)
  WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.'||required.name)
   AND c.relrowsecurity AND c.relforcerowsecurity AND pg_catalog.pg_get_userbyid(c.relowner)='jrc_migrator'))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=pg_catalog.to_regclass('public.meta_connections')
  AND conname='meta_waba_owner_fk' AND contype='f' AND convalidated)
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=pg_catalog.to_regclass('public.meta_connections')
  AND tgname='meta_waba_owner_guard' AND tgenabled IN ('O','A') AND NOT tgisinternal
  AND tgfoid=pg_catalog.to_regprocedure('public.enforce_meta_waba_owner()'))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=pg_catalog.to_regprocedure('public.claim_meta_waba(text)')
  AND p.prosecdef AND pg_catalog.pg_get_userbyid(p.proowner)='jrc_migrator'
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=0))
 AND pg_catalog.has_function_privilege('jrc_app',pg_catalog.to_regprocedure('public.claim_meta_waba(text)'),'EXECUTE')
 AND pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass('public.meta_management_events'),'INSERT')
 AND NOT pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass('public.meta_waba_ownership'),'UPDATE')
 AND NOT pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass('public.meta_waba_ownership'),'DELETE')`;
