export const RUNTIME_SCHEMA_BASELINE = '0031_economic_groups';

type SchemaProbeQuery = (sql: string) => Promise<{ rows: Array<{ ready: boolean | null }> }>;

// The app role cannot read drizzle.__drizzle_migrations. This is a structural
// readiness probe, not a migration journal/hash comparison.
const requiredObjectsSql = `SELECT
  pg_catalog.to_regclass('public.messaging_media') IS NOT NULL
  AND pg_catalog.to_regclass('public.automation_definitions') IS NOT NULL
  AND pg_catalog.to_regclass('public.automation_import_artifacts') IS NOT NULL
  AND pg_catalog.to_regclass('public.operational_heartbeats') IS NOT NULL
  AND pg_catalog.to_regclass('public.automation_legacy_migrations') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = pg_catalog.to_regclass('public.instances')
      AND attname = 'archived_at' AND attnum > 0 AND NOT attisdropped
  )
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('public.instances', 'tenant_instances_restore_admission'),
      ('public.provider_operations', 'instance_archive_operations'),
      ('public.messaging_channels', 'instance_archive_channels'),
      ('public.messaging_messages', 'instance_archive_messages'),
      ('public.messaging_messages', 'instance_archive_message_retry'),
      ('public.automation_bindings', 'instance_archive_bindings'),
      ('public.automation_executions', 'instance_archive_executions'),
      ('public.chatwoot_connections', 'instance_archive_inbox_create'),
      ('public.chatwoot_connections', 'instance_archive_inbox_resume')
    ) AS required(relation_name, trigger_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = pg_catalog.to_regclass(required.relation_name)
        AND t.tgname = required.trigger_name
        AND t.tgenabled IN ('O', 'A')
        AND NOT t.tgisinternal
    )
  )
  AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = pg_catalog.to_regclass('public.automation_bindings')
      AND conname = 'automation_binding_destination' AND contype = 'f'
  )
  AND pg_catalog.to_regclass('public.economic_groups') IS NOT NULL
  AND pg_catalog.to_regclass('public.economic_group_organizations') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('public.economic_groups'),
      ('public.economic_group_organizations')
    ) AS required(relation_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid = pg_catalog.to_regclass(required.relation_name)
        AND c.relrowsecurity AND c.relforcerowsecurity
        AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_policy p
          WHERE p.polrelid = c.oid
            AND p.polname = 'platform_boundary'
        )
    )
  )
  AS ready`;

export async function probeRequiredRuntimeSchema(query: SchemaProbeQuery): Promise<boolean> {
  const result = await query(requiredObjectsSql);
  return result.rows[0]?.ready === true;
}
