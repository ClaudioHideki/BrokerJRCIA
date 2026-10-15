export const conversationEffectsRuntimeSql=`
 EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.automation_effect_control_steps')
  AND c.relrowsecurity AND c.relforcerowsecurity AND pg_catalog.pg_get_userbyid(c.relowner)='jrc_migrator'
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='effect_control_tenant'
   AND p.polcmd='*' AND p.polroles=ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='jrc_app')]))
 AND pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass('public.automation_effect_control_steps'),'SELECT')
 AND pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass('public.automation_effect_control_steps'),'INSERT')
 AND NOT pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass('public.automation_effect_control_steps'),'UPDATE,DELETE')
 AND NOT EXISTS(SELECT 1 FROM (VALUES ('protocol_version'),('remote_context'),('request_body'),('confirmed_receipt')) required(name)
  WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass('public.automation_conversation_effects')
   AND attname=required.name AND attnum>0 AND NOT attisdropped))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=pg_catalog.to_regclass('public.automation_conversation_effects')
  AND conname='conversation_effect_v2_proof' AND convalidated)
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=pg_catalog.to_regclass('public.chatwoot_attendance_observations')
  AND conname='attendance_effect_scope' AND convalidated)
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=pg_catalog.to_regclass('public.automation_conversation_effects')
  AND tgname='conversation_effect_v2_immutable' AND tgenabled='O'
  AND tgfoid=pg_catalog.to_regprocedure('public.conversation_effect_v2_immutable()'))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_index WHERE indexrelid=pg_catalog.to_regclass('public.conversation_effect_one_open') AND indisunique AND indisvalid)
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_index WHERE indexrelid=pg_catalog.to_regclass('public.automation_private_notes_conversation_recent') AND indisvalid)
`;
