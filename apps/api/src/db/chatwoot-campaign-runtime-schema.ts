export const campaignRuntimeSql=`
 EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.chatwoot_campaign_intents')
  AND c.relrowsecurity AND c.relforcerowsecurity AND pg_catalog.pg_get_userbyid(c.relowner)='jrc_migrator'
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='campaign_tenant' AND p.polcmd='*'
   AND p.polroles=ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='jrc_app')]
   AND regexp_replace(pg_catalog.pg_get_expr(p.polqual,p.polrelid),'[[:space:]()]','','g')='organization_id=NULLIFcurrent_setting''app.organization_id''::text,true,''''::text::uuid'
   AND pg_catalog.pg_get_expr(p.polqual,p.polrelid)=pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid))
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='lifecycle_migrator'
   AND p.polroles=ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='jrc_migrator')]
   AND pg_catalog.pg_get_expr(p.polqual,p.polrelid)='true' AND pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)='true')
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname NOT IN ('campaign_tenant','lifecycle_migrator'))
  AND pg_catalog.has_table_privilege('jrc_app',c.oid,'SELECT') AND pg_catalog.has_table_privilege('jrc_app',c.oid,'INSERT')
  AND NOT pg_catalog.has_table_privilege('jrc_app',c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a WHERE a.grantee=0)
  AND NOT EXISTS(SELECT 1 FROM (VALUES('jrc_auth'),('jrc_platform'),('jrc_lifecycle')) forbidden(role_name)
   WHERE pg_catalog.has_table_privilege(forbidden.role_name,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR pg_catalog.has_any_column_privilege(forbidden.role_name,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
   AND pg_catalog.has_column_privilege('jrc_app',c.oid,a.attnum,'UPDATE')<>(a.attname='local_conversation_id')))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=pg_catalog.to_regclass('public.messaging_messages')
  AND a.attname='campaign_intent_id' AND a.atttypid=pg_catalog.to_regtype('uuid') AND NOT a.attisdropped AND NOT a.attnotnull)
 AND NOT EXISTS(SELECT 1 FROM (VALUES('attachment_ids','jsonb'),('api_key_id','uuid'),('actor_id','text'),('destination_revision','integer'),
  ('credential_version','integer'),('remote_contact_id','bigint'),('recipient_phone','text'),('recipient_source_id','text'),('identity_revision','integer'),('owner_revision','integer'),('remote_conversation_id','bigint'),('remote_message_id','bigint'),('expires_at','timestamp with time zone')) required(name,type_name)
  WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=pg_catalog.to_regclass('public.chatwoot_campaign_intents')
   AND a.attname=required.name AND a.atttypid=pg_catalog.to_regtype(required.type_name) AND a.attnotnull AND NOT a.attisdropped))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=pg_catalog.to_regclass('public.messaging_messages')
  AND t.tgname='campaign_message_authority' AND t.tgenabled IN ('O','A') AND t.tgtype=19 AND t.tgattr::text='' AND t.tgqual IS NULL AND NOT t.tgisinternal
  AND t.tgfoid=pg_catalog.to_regprocedure('public.campaign_require_message_authority()'))
 AND NOT EXISTS(SELECT 1 FROM (VALUES('public.campaign_intent_authorized(uuid,uuid,boolean)',true),('public.campaign_require_message_authority()',false),('public.campaign_catalogue_ready()',true)) required(name,app_execute)
  WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=pg_catalog.to_regprocedure(required.name)
   AND p.prosecdef AND pg_catalog.pg_get_userbyid(p.proowner)='jrc_migrator' AND p.proconfig @> ARRAY['search_path=pg_catalog, public']::text[]
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=0)
   AND pg_catalog.has_function_privilege('jrc_app',p.oid,'EXECUTE')=required.app_execute
   AND NOT EXISTS(SELECT 1 FROM (VALUES('jrc_auth'),('jrc_platform'),('jrc_lifecycle')) forbidden(role_name)
    WHERE pg_catalog.has_function_privilege(forbidden.role_name,p.oid,'EXECUTE'))))
 AND CASE WHEN pg_catalog.to_regprocedure('public.campaign_catalogue_ready()') IS NULL THEN false ELSE public.campaign_catalogue_ready() END
`;
