import { describe, expect, it, vi } from 'vitest';

import { loadExpectedMigrations } from './schema-status.js';
import { RUNTIME_SCHEMA_BASELINE, probeRequiredRuntimeSchema } from './runtime-schema.js';

describe('runtime schema probe', () => {
  it('keeps the required baseline aligned with the newest migration', async () => {
    const migrations = await loadExpectedMigrations();
    expect(RUNTIME_SCHEMA_BASELINE).toBe(migrations.at(-1)?.name);
  });

  it('refuses an older schema even when the observability table exists', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [{ ready: false }] }));
    expect(await probeRequiredRuntimeSchema(query)).toBe(false);
    const sql = query.mock.calls[0]?.[0] ?? '';
    expect(sql).toContain('operational_heartbeats');
    expect(sql).toContain('automation_legacy_migrations');
    expect(sql).toContain('archived_at');
    expect(sql).toContain('economic_groups');
    expect(sql).toContain('economic_group_organizations');
  });

  it('requires the archival triggers and forced group policies, not only their tables', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [{ ready: false }] }));
    await probeRequiredRuntimeSchema(query);
    const sql = query.mock.calls[0]?.[0] ?? '';
    for (const trigger of [
      'tenant_instances_restore_admission',
      'instance_archive_operations',
      'instance_archive_channels',
      'instance_archive_messages',
      'instance_archive_message_retry',
      'instance_archive_bindings',
      'instance_archive_executions',
      'instance_archive_inbox_create',
      'instance_archive_inbox_resume',
    ]) expect(sql).toContain(trigger);
    expect(sql).toContain('automation_binding_destination');
    expect(sql).toContain('platform_boundary');
    expect(sql).toContain('relforcerowsecurity');
  });

  it('accepts required objects and fails closed on a missing result', async () => {
    expect(await probeRequiredRuntimeSchema(async () => ({ rows: [{ ready: true }] }))).toBe(true);
    expect(await probeRequiredRuntimeSchema(async () => ({ rows: [] }))).toBe(false);
  });
});
