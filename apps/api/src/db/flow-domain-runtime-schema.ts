export const flowDomainRuntimeSql=`EXISTS(SELECT 1 FROM pg_catalog.pg_constraint
 WHERE conrelid=pg_catalog.to_regclass('public.automation_conversation_effects')
 AND conname='automation_conversation_effects_operation_check' AND convalidated
 AND pg_catalog.pg_get_constraintdef(oid) LIKE '%domain%')`;
