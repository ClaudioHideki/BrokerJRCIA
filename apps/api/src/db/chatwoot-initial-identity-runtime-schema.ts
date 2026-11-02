export const initialIdentityRuntimeSql = `
 NOT EXISTS(SELECT 1 FROM (VALUES ('initial_identity_intent','jsonb'),('initial_identity_expires_at','timestamp with time zone'),
  ('initial_identity_pair_expires_at','timestamp with time zone')) required(name,type_name)
  WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=pg_catalog.to_regclass('public.chatwoot_connection_health')
   AND a.attname=required.name AND a.atttypid=pg_catalog.to_regtype(required.type_name) AND NOT a.attnotnull AND NOT a.attisdropped))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid=pg_catalog.to_regclass('public.chatwoot_connection_health')
  AND c.conname='chatwoot_initial_identity_shape' AND c.contype='c' AND c.convalidated)
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.chatwoot_connection_health')
  AND c.relrowsecurity AND c.relforcerowsecurity AND pg_catalog.pg_get_userbyid(c.relowner)='jrc_migrator'
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='chatwoot_connection_health_tenant')
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='lifecycle_migrator'))
`;
