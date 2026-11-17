/** Structural release gate for the optional source host. Never admits a login,
 * enables capture or runs operational maintenance while probing readiness. */
export const historySourceRuntimeSql=`
EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='jrc_origin' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole)
AND NOT EXISTS(SELECT 1 FROM (VALUES ('public.history_origin_engine_roles'),('public.history_sync_connection_policies'),
 ('public.history_source_sessions'),('jrc_evolution_origin.events'),('jrc_evolution_origin.attempts'),
 ('jrc_evolution_origin.history_batches'),('jrc_evolution_origin.history_chunks'),('jrc_evolution_origin.history_media')) required(name)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass(required.name)
  AND c.relrowsecurity AND c.relforcerowsecurity AND pg_catalog.pg_get_userbyid(c.relowner)='jrc_migrator'
  AND NOT pg_catalog.has_table_privilege('jrc_app',c.oid,'DELETE')
  AND NOT pg_catalog.has_table_privilege('jrc_auth',c.oid,'SELECT')
  AND NOT pg_catalog.has_table_privilege('jrc_platform',c.oid,'SELECT')
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a WHERE a.grantee=0)))
AND EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=pg_catalog.to_regclass('public.history_source_sessions')
 AND a.attname='origin_role_name' AND a.attnotnull AND NOT a.attisdropped)
AND EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=pg_catalog.to_regclass('jrc_evolution_origin.history_media')
 AND a.attname='live_message_key' AND NOT a.attisdropped AND pg_catalog.format_type(a.atttypid,a.atttypmod)='character(64)')
AND EXISTS(SELECT 1 FROM pg_catalog.pg_index i WHERE i.indexrelid=pg_catalog.to_regclass('jrc_evolution_origin.origin_live_media_key')
 AND i.indrelid=pg_catalog.to_regclass('jrc_evolution_origin.history_media') AND i.indisunique AND i.indisvalid AND i.indisready
 AND pg_catalog.pg_get_indexdef(i.indexrelid) LIKE '%(scope_key, run_id, live_message_key)%'
 AND pg_catalog.pg_get_expr(i.indpred,i.indrelid)='(live_message_key IS NOT NULL)')
AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid=pg_catalog.to_regclass('public.whatsapp_group_transport_facts')
 AND c.conname='whatsapp_group_transport_facts_content_check' AND c.contype='c' AND c.convalidated
 AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%MEDIA%' AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%mediaId%'
 AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%fileName%')
AND NOT EXISTS(SELECT 1 FROM (VALUES
 ('public.history_source_open(text,uuid,text)',false,true),('public.history_origin_host_identity()',false,true),
 ('public.history_source_lifecycle_ready()',true,false),
 ('public.history_register_origin_engine(text,text,bigint,text)',false,false),
 ('public.history_source_assert(uuid)',true,true),('public.history_source_bind_owner(uuid,jsonb)',false,true),
 ('public.history_source_owner(uuid)',false,true),('public.history_sync_enable_connection(uuid,uuid,uuid,uuid,jsonb,uuid)',true,false),
 ('public.history_origin_can_access(text,uuid,uuid)',true,true)) required(name,app,origin)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=pg_catalog.to_regprocedure(required.name)
  AND p.prosecdef AND pg_catalog.pg_get_userbyid(p.proowner)='jrc_migrator'
  AND p.proconfig @> ARRAY['search_path=pg_catalog, public']
  AND pg_catalog.has_function_privilege('jrc_app',p.oid,'EXECUTE')=required.app
  AND pg_catalog.has_function_privilege('jrc_origin',p.oid,'EXECUTE')=required.origin
  AND NOT pg_catalog.has_function_privilege('jrc_auth',p.oid,'EXECUTE')
  AND NOT pg_catalog.has_function_privilege('jrc_platform',p.oid,'EXECUTE')
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=0)))
AND NOT EXISTS(SELECT 1 FROM (VALUES ('events'),('attempts'),('history_batches'),('history_chunks'),('history_media')) required(name)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('jrc_evolution_origin.'||required.name)
  AND pg_catalog.has_table_privilege('jrc_app',c.oid,'SELECT') AND pg_catalog.has_table_privilege('jrc_app',c.oid,'INSERT')
  AND pg_catalog.has_table_privilege('jrc_app',c.oid,'UPDATE') AND NOT pg_catalog.has_table_privilege('jrc_origin',c.oid,'DELETE')
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='origin_migrator' AND p.polcmd='*'
   AND p.polroles=ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='jrc_migrator')])
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polcmd='*'
   AND p.polroles @> ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='jrc_app'),(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='jrc_origin')]
   AND pg_catalog.pg_get_expr(p.polqual,p.polrelid) IS NOT NULL AND pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid) IS NOT NULL)))`;
