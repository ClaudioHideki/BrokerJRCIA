// Structural gate for the additive audit corrections; no customer data or journal access.
const tenantExpression = "organization_id=NULLIFcurrent_setting'app.organization_id'::text,true,''::text::uuid";
export const auditCorrectionsRuntimeSql = `
 NOT EXISTS(SELECT 1 FROM (VALUES ('media_custody_receipts','media_custody_tenant',true),
   ('partner_delivery_replays','partner_replay_tenant',false)) required(name,policy_name,app_insert)
  WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.'||required.name)
   AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity AND pg_catalog.pg_get_userbyid(c.relowner)='jrc_migrator'
   AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname=required.policy_name
    AND p.polcmd='*' AND p.polpermissive AND p.polroles=ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='jrc_app')]
    AND regexp_replace(pg_catalog.pg_get_expr(p.polqual,p.polrelid),'[[:space:]()]','','g')='${tenantExpression.replaceAll("'", "''")}'
    AND regexp_replace(pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid),'[[:space:]()]','','g')='${tenantExpression.replaceAll("'", "''")}')
   AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='lifecycle_migrator'
    AND p.polcmd='*' AND p.polpermissive
    AND p.polroles=ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='jrc_migrator')]
    AND pg_catalog.pg_get_expr(p.polqual,p.polrelid)='true' AND pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)='true')
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname NOT IN (required.policy_name,'lifecycle_migrator'))
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a WHERE a.grantee=0))
  OR NOT pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass('public.'||required.name),'SELECT')
  OR pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass('public.'||required.name),'INSERT')<>required.app_insert
  OR pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass('public.'||required.name),'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR EXISTS(SELECT 1 FROM (VALUES('jrc_auth'),('jrc_platform'),('jrc_lifecycle')) forbidden(role_name)
   WHERE pg_catalog.has_table_privilege(forbidden.role_name,pg_catalog.to_regclass('public.'||required.name),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR pg_catalog.has_any_column_privilege(forbidden.role_name,pg_catalog.to_regclass('public.'||required.name),'SELECT,INSERT,UPDATE,REFERENCES'))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=pg_catalog.to_regclass('public.'||required.name)
   AND a.attnum>0 AND NOT a.attisdropped AND (
    pg_catalog.has_column_privilege('jrc_app',a.attrelid,a.attnum,'INSERT')<>required.app_insert
    OR pg_catalog.has_column_privilege('jrc_app',a.attrelid,a.attnum,'UPDATE,REFERENCES'))))
 AND NOT EXISTS(SELECT 1 FROM (VALUES
  ('instances','connection_observed_at','timestamp with time zone',false),('instances','connection_binding_fingerprint','text',false),
  ('partner_event_deliveries','lifetime_attempts','bigint',true),('partner_event_deliveries','replay_count','integer',true),
  ('media_custody_receipts','request_hash','text',true),('media_custody_receipts','retention_policy','text',true)) required(relation_name,column_name,type_name,not_null)
  WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=pg_catalog.to_regclass('public.'||required.relation_name)
   AND a.attname=required.column_name AND a.atttypid=pg_catalog.to_regtype(required.type_name)
   AND a.attnotnull=required.not_null AND a.attnum>0 AND NOT a.attisdropped))
 AND NOT EXISTS(SELECT 1 FROM (VALUES
  ('media_custody_receipts','a_media_custody_authority','public.media_custody_require_authority()',23),
  ('media_custody_receipts','media_custody_lifecycle_admission','public.lifecycle_reject_channel_write()',7),
  ('partner_delivery_replays','partner_delivery_replay_immutable','public.partner_delivery_replay_immutable()',23),
  ('partner_event_deliveries','partner_delivery_attempt_fence','public.partner_delivery_attempt_fence()',19)) required(relation_name,trigger_name,function_name,trigger_type)
  WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=pg_catalog.to_regclass('public.'||required.relation_name)
   AND t.tgname=required.trigger_name AND t.tgtype=required.trigger_type AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal
   AND t.tgqual IS NULL AND t.tgattr::text=''
   AND t.tgfoid=pg_catalog.to_regprocedure(required.function_name)))
 AND NOT EXISTS(SELECT 1 FROM (VALUES
  ('public.media_custody_require_authority()',true,false),('public.partner_delivery_replay_immutable()',false,false),
  ('public.partner_delivery_attempt_fence()',false,false),('public.partner_delivery_require_authority(uuid)',true,false),
  ('public.partner_replay_delivery(uuid,uuid,uuid)',true,true),('public.partner_delivery_stats(uuid,uuid)',true,true),
  ('public.audit_corrections_catalogue_ready()',true,true)) required(function_name,security_definer,app_execute)
  WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=pg_catalog.to_regprocedure(required.function_name)
   AND p.prosecdef=required.security_definer AND pg_catalog.pg_get_userbyid(p.proowner)='jrc_migrator'
   AND regexp_replace(array_to_string(p.proconfig,','),'[[:space:]]','','g')='search_path=pg_catalog,public'
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=0)
   AND pg_catalog.has_function_privilege('jrc_app',p.oid,'EXECUTE')=required.app_execute
   AND NOT EXISTS(SELECT 1 FROM (VALUES('jrc_auth'),('jrc_platform'),('jrc_lifecycle')) forbidden(role_name)
    WHERE pg_catalog.has_function_privilege(forbidden.role_name,p.oid,'EXECUTE'))))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid=pg_catalog.to_regclass('public.instances')
  AND c.conname='instances_connection_clock_scope' AND c.convalidated)
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid=pg_catalog.to_regclass('public.messaging_messages')
  AND c.conname='messaging_messages_custody_reference_unique' AND c.contype='u' AND c.convalidated)
 AND (SELECT count(*)=3 FROM pg_catalog.pg_constraint c WHERE c.conrelid=pg_catalog.to_regclass('public.media_custody_receipts')
  AND c.contype='f' AND c.convalidated AND c.confrelid IN ('public.messaging_messages'::regclass,'public.messaging_media'::regclass,'public.partner_webhook_endpoints'::regclass))`;
