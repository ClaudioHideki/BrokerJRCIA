const tables = ['partner_webhook_endpoints', 'partner_events', 'partner_event_deliveries', 'partner_event_cursor_state'];
const tableValues = tables.map(name => `('public.${name}')`).join(',');
// Compare normalized PostgreSQL expressions rather than trusting a policy name.
const tenantExpression = "organization_id=NULLIFcurrent_setting'app.organization_id'::text,true,''::text::uuid";
const mutableColumns = {
  partner_webhook_endpoints: ['status', 'encrypted_secret', 'revoked_at'],
  partner_event_deliveries: ['status', 'attempts', 'available_at', 'last_error_code', 'updated_at', 'lease_token', 'lease_expires_at'],
};

export const partnerApiRuntimeSql = `
 NOT EXISTS(SELECT 1 FROM (VALUES ${tableValues}) required(name)
  WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass(required.name)
   AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity
   AND pg_catalog.pg_get_userbyid(c.relowner)='jrc_migrator'
   AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='partner_tenant'
    AND p.polcmd='*' AND p.polpermissive AND p.polroles=ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='jrc_app')]
    AND regexp_replace(pg_catalog.pg_get_expr(p.polqual,p.polrelid),'[[:space:]()]','','g')='${tenantExpression.replaceAll("'", "''")}'
    AND regexp_replace(pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid),'[[:space:]()]','','g')='${tenantExpression.replaceAll("'", "''")}')
   AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='lifecycle_migrator'
    AND p.polcmd='*' AND p.polroles=ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='jrc_migrator')]
    AND pg_catalog.pg_get_expr(p.polqual,p.polrelid)='true' AND pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)='true')
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname NOT IN ('partner_tenant','lifecycle_migrator'))
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a WHERE a.grantee=0))
  OR NOT pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass(required.name),'SELECT')
  OR pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass(required.name),'INSERT')<>(required.name='public.partner_webhook_endpoints')
  OR pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass(required.name),'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR EXISTS(SELECT 1 FROM (VALUES ('jrc_auth'),('jrc_platform'),('jrc_lifecycle')) forbidden(role_name)
   WHERE pg_catalog.has_table_privilege(forbidden.role_name,pg_catalog.to_regclass(required.name),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR pg_catalog.has_any_column_privilege(forbidden.role_name,pg_catalog.to_regclass(required.name),'SELECT,INSERT,UPDATE,REFERENCES'))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=pg_catalog.to_regclass(required.name) AND a.attnum>0 AND NOT a.attisdropped
   AND (pg_catalog.has_column_privilege('jrc_app',a.attrelid,a.attnum,'INSERT')<>(required.name='public.partner_webhook_endpoints')
    OR pg_catalog.has_column_privilege('jrc_app',a.attrelid,a.attnum,'REFERENCES')
    OR pg_catalog.has_column_privilege('jrc_app',a.attrelid,a.attnum,'UPDATE')<>CASE
     ${Object.entries(mutableColumns).map(([name, columns]) => `WHEN required.name='public.${name}' THEN a.attname::text=ANY(ARRAY[${columns.map(column => `'${column}'`).join(',')}])`).join('\n')}
     ELSE false END)))
 AND NOT EXISTS(SELECT 1 FROM (VALUES
  ('public.messaging_messages','authorizing_api_key_id','uuid',false),
  ('public.partner_events','sequence_number','bigint',false),
  ('public.partner_event_cursor_state','last_pruned_cursor','bigint',true)) required(relation_name,column_name,type_name,not_null)
  WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=pg_catalog.to_regclass(required.relation_name)
   AND a.attname=required.column_name AND a.attnum>0 AND NOT a.attisdropped
   AND a.atttypid=pg_catalog.to_regtype(required.type_name) AND a.attnotnull=required.not_null))
 AND NOT EXISTS(SELECT 1 FROM (VALUES
  ('public.messaging_messages','partner_message_event','state'),
  ('public.instances','partner_connection_event','status'),
  ('public.meta_connections','partner_meta_connection_event','status')) required(relation_name,trigger_name,column_name)
  WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=pg_catalog.to_regclass(required.relation_name)
   AND t.tgname=required.trigger_name AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal AND t.tgtype=21
   AND t.tgfoid=pg_catalog.to_regprocedure('public.partner_capture_event()')
   AND t.tgattr::text=(SELECT a.attnum::text FROM pg_catalog.pg_attribute a WHERE a.attrelid=t.tgrelid AND a.attname=required.column_name)))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=pg_catalog.to_regclass('public.messaging_messages')
  AND t.tgname='partner_message_authority' AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal
  AND t.tgtype=19 AND t.tgqual IS NULL AND t.tgfoid=pg_catalog.to_regprocedure('public.partner_require_message_authority()')
  AND t.tgattr::text=(SELECT a.attnum::text FROM pg_catalog.pg_attribute a
   WHERE a.attrelid=t.tgrelid AND a.attname='state'))
 AND NOT EXISTS(SELECT 1 FROM (VALUES
  ('public.partner_capture_event()',false),('public.partner_publish_events()',true),
  ('public.partner_event_worker_organizations(uuid,integer)',true),('public.partner_event_catalogue_ready()',true),
  ('public.partner_require_message_authority()',false)) required(name,app_execute)
  WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=pg_catalog.to_regprocedure(required.name)
   AND p.prosecdef AND pg_catalog.pg_get_userbyid(p.proowner)='jrc_migrator'
   AND EXISTS(SELECT 1 FROM unnest(p.proconfig) config WHERE regexp_replace(config,'[[:space:]]','','g')='search_path=pg_catalog,public')
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=0)
   AND pg_catalog.has_function_privilege('jrc_app',p.oid,'EXECUTE')=required.app_execute
   AND NOT pg_catalog.has_function_privilege('jrc_auth',p.oid,'EXECUTE')
   AND NOT pg_catalog.has_function_privilege('jrc_platform',p.oid,'EXECUTE')
   AND NOT pg_catalog.has_function_privilege('jrc_lifecycle',p.oid,'EXECUTE')))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.partner_event_order_seq')
  AND c.relkind='S' AND pg_catalog.pg_get_userbyid(c.relowner)='jrc_migrator'
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('S',c.relowner))) a WHERE a.grantee=0)
  AND NOT EXISTS(SELECT 1 FROM (VALUES ('jrc_app'),('jrc_auth'),('jrc_platform'),('jrc_lifecycle')) forbidden(role_name)
   WHERE pg_catalog.has_sequence_privilege(forbidden.role_name,c.oid,'USAGE,SELECT,UPDATE')))`;
