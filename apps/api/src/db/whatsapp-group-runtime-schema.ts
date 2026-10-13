/** Structural readiness for the reserved0054 group runtime. Predecessors remain required. */
export const whatsappGroupRuntimeSql=`
 NOT EXISTS(SELECT 1 FROM (VALUES ('whatsapp_group_automation_controls'),('whatsapp_group_automation_sessions'),('whatsapp_group_transport_facts')) required(name)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.'||required.name)
  AND c.relrowsecurity AND c.relforcerowsecurity AND pg_catalog.pg_get_userbyid(c.relowner)='jrc_migrator'
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='group_runtime_tenant' AND p.polcmd='*'
    AND p.polroles=ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='jrc_app')]))
 OR NOT pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass('public.'||required.name),'SELECT')
 OR NOT pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass('public.'||required.name),'INSERT')
 OR NOT pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass('public.'||required.name),'UPDATE')
 OR pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass('public.'||required.name),'DELETE')
 OR pg_catalog.has_table_privilege('jrc_auth',pg_catalog.to_regclass('public.'||required.name),'SELECT')
 OR pg_catalog.has_table_privilege('jrc_platform',pg_catalog.to_regclass('public.'||required.name),'SELECT')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c,LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl
   WHERE c.oid=pg_catalog.to_regclass('public.'||required.name) AND acl.grantee=0))
 AND NOT EXISTS(SELECT 1 FROM (VALUES
  ('messaging_conversations','recipient_kind'),('messaging_conversations','group_jid'),
  ('messaging_messages','provider_scope'),('messaging_status_events','provider_scope'),('qr_outbound_observations','provider_scope'),
  ('whatsapp_group_automation_controls','activation_revision'),('whatsapp_group_automation_sessions','activation_revision'),
  ('whatsapp_group_transport_facts','identity_revision')) required(name,column_name)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=pg_catalog.to_regclass('public.'||required.name)
  AND a.attname=required.column_name AND a.attnum>0 AND NOT a.attisdropped))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=pg_catalog.to_regclass('public.messaging_conversations')
  AND a.attname='contact_id' AND NOT a.attnotnull AND NOT a.attisdropped)
 AND NOT EXISTS(SELECT 1 FROM (VALUES
  ('whatsapp_group_automation_controls','lifecycle_group_runtime_block','lifecycle_reject_channel_write()',7),
  ('whatsapp_group_automation_sessions','lifecycle_group_runtime_block','lifecycle_reject_channel_write()',7),
  ('whatsapp_group_transport_facts','lifecycle_group_runtime_block','lifecycle_reject_channel_write()',7),
  ('whatsapp_group_automation_sessions','whatsapp_group_session_immutable','whatsapp_group_session_immutable()',19),
  ('messaging_messages','group_message_scope','whatsapp_group_message_scope()',23),
  ('qr_outbound_observations','group_observation_scope','whatsapp_group_message_scope()',23)) required(name,trigger_name,function_name,trigger_type)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=pg_catalog.to_regclass('public.'||required.name)
  AND t.tgname=required.trigger_name AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal AND t.tgtype=required.trigger_type
  AND t.tgfoid=pg_catalog.to_regprocedure('public.'||required.function_name)))
 AND NOT EXISTS(SELECT 1 FROM (VALUES ('messaging_conversations_group_unique'),('whatsapp_group_one_live_session'),('messaging_messages_upstream_unique')) required(name)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i WHERE i.indexrelid=pg_catalog.to_regclass('public.'||required.name) AND i.indisunique AND i.indisvalid))
 AND NOT EXISTS(SELECT 1 FROM (VALUES
  ('messaging_conversations','messaging_conversation_recipient','c'),
  ('messaging_conversations','messaging_conversations_group_scope_unique','u'),
  ('automation_executions','automation_executions_conversation_scope_unique','u'),
  ('qr_outbound_observations','qr_observation_scoped_id','u'),
  ('messaging_status_events','messaging_status_events_dedupe_unique','u')) required(name,constraint_name,kind)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid=pg_catalog.to_regclass('public.'||required.name)
  AND c.conname=required.constraint_name AND c.contype::text=required.kind AND c.convalidated))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_proc f WHERE f.oid=pg_catalog.to_regprocedure('public.whatsapp_group_provider_scope(uuid,uuid)')
  AND pg_catalog.pg_get_userbyid(f.proowner)='jrc_migrator'
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(f.proacl,pg_catalog.acldefault('f',f.proowner))) acl WHERE acl.grantee=0))
 AND pg_catalog.has_function_privilege('jrc_app',pg_catalog.to_regprocedure('public.whatsapp_group_provider_scope(uuid,uuid)'),'EXECUTE')
 -- App-role readiness must inspect metadata, never read the migrator-only
 -- lifecycle catalogue or acquire administrative grants for this projection.
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_proc f WHERE f.oid=pg_catalog.to_regprocedure('public.lifecycle_purge_channel(uuid,uuid)')
  AND pg_catalog.pg_get_userbyid(f.proowner)='jrc_migrator'
  AND f.prosrc LIKE '%DELETE FROM public.whatsapp_group_transport_facts WHERE organization_id=org AND channel_id=channel;%'
  AND f.prosrc LIKE '%DELETE FROM public.whatsapp_group_automation_sessions WHERE organization_id=org AND channel_id=channel;%'
  AND f.prosrc LIKE '%DELETE FROM public.whatsapp_group_automation_controls WHERE organization_id=org AND channel_id=channel;%')
`;
