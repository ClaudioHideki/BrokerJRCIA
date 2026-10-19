export const historyImportRuntimeSql=`NOT EXISTS(SELECT 1 FROM (VALUES ('history_import_jobs'),('history_import_pages'),('history_import_snapshots')) required(table_name)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.'||required.table_name)
  AND c.relrowsecurity AND c.relforcerowsecurity AND pg_catalog.pg_get_userbyid(c.relowner)='jrc_migrator'
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='history_import_tenant'
   AND p.polroles=ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='jrc_app')])
  AND pg_catalog.has_table_privilege('jrc_app',c.oid,'SELECT') AND pg_catalog.has_table_privilege('jrc_app',c.oid,'INSERT')
  AND NOT pg_catalog.has_table_privilege('jrc_app',c.oid,'DELETE')
  AND pg_catalog.has_table_privilege('jrc_app',c.oid,'UPDATE')=(required.table_name='history_import_jobs')
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl WHERE acl.grantee=0)
  AND NOT pg_catalog.has_table_privilege('jrc_auth',c.oid,'SELECT') AND NOT pg_catalog.has_table_privilege('jrc_platform',c.oid,'SELECT')
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='history_import_channel_admission'
   AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal)))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=pg_catalog.to_regclass('public.history_import_jobs')
  AND t.tgname='history_import_job_guard' AND (t.tgtype::integer&20)=20 AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal)
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=pg_catalog.to_regclass('public.history_import_pages')
  AND t.tgname='history_import_receipt_checkpoint' AND t.tgenabled IN ('O','A') AND t.tgdeferrable AND t.tginitdeferred
  AND t.tgfoid=pg_catalog.to_regprocedure('public.history_import_receipt_checkpoint()') AND NOT t.tgisinternal)
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass('public.history_import_jobs')
  AND attname='next_ordinal' AND atttypid='bigint'::regtype AND attnotnull AND attnum>0 AND NOT attisdropped)
 AND NOT EXISTS(SELECT 1 FROM (VALUES
   ('history_import_jobs','actor_id','uuid',false),('history_import_pages','actor_id','uuid',false),
   ('messaging_messages','is_historical','boolean',true),
   ('history_import_jobs','next_attempt_at','timestamp with time zone',true),('history_import_jobs','last_error','text',false)
  ) required(table_name,column_name,type_name,required_not_null) WHERE NOT EXISTS(
   SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=pg_catalog.to_regclass('public.'||required.table_name)
    AND a.attname=required.column_name AND a.atttypid=pg_catalog.to_regtype(required.type_name)
    AND a.attnotnull=required.required_not_null AND a.attnum>0 AND NOT a.attisdropped))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=pg_catalog.to_regclass('public.integration_jobs')
  AND conname='integration_jobs_status_check' AND contype='c' AND pg_catalog.pg_get_constraintdef(oid) LIKE '%HISTORY_PENDING%')
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=pg_catalog.to_regprocedure('public.history_import_expire_snapshots()')
  AND p.prosecdef AND pg_catalog.pg_get_userbyid(p.proowner)='jrc_migrator'
  AND p.proconfig @> ARRAY['search_path=pg_catalog, public']
  AND pg_catalog.has_function_privilege('jrc_app',p.oid,'EXECUTE')
  AND NOT pg_catalog.has_function_privilege('jrc_auth',p.oid,'EXECUTE')
  AND NOT pg_catalog.has_function_privilege('jrc_platform',p.oid,'EXECUTE')
  AND NOT pg_catalog.has_function_privilege('jrc_lifecycle',p.oid,'EXECUTE')
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl WHERE acl.grantee=0))`;
