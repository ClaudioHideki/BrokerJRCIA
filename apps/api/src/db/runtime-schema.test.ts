import { describe, expect, it, vi } from 'vitest';

import { loadExpectedMigrations } from './schema-status.js';
import { RUNTIME_SCHEMA_BASELINE, probeRequiredRuntimeSchema } from './runtime-schema.js';

describe('runtime schema probe', () => {
  it('only invokes private catalogue functions after their structural guards have passed', async () => {
    const query=vi.fn(async (_sql:string)=>({rows:[{ready:true}]}));
    expect(await probeRequiredRuntimeSchema(query)).toBe(true);
    expect(query.mock.calls[0]?.[0]).not.toContain('ELSE public.campaign_catalogue_ready()');
    expect(query.mock.calls[1]?.[0]).toBe('SELECT public.partner_event_catalogue_ready() AND public.campaign_catalogue_ready() AS ready');
  });
  it('returns false if a checked catalogue function disappears before invocation, without masking other failures',async()=>{
    const missing=vi.fn().mockResolvedValueOnce({rows:[{ready:true}]}).mockRejectedValueOnce(Object.assign(new Error('Missing function'),{code:'42883'}));
    expect(await probeRequiredRuntimeSchema(missing)).toBe(false);
    const denied=vi.fn().mockResolvedValueOnce({rows:[{ready:true}]}).mockRejectedValueOnce(Object.assign(new Error('Denied'),{code:'42501'}));
    await expect(probeRequiredRuntimeSchema(denied)).rejects.toMatchObject({code:'42501'});
  });
  it('requires partner event isolation, publisher guards and queued credential authority', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [{ ready: false }] }));
    await probeRequiredRuntimeSchema(query);
    const sql = query.mock.calls[0]?.[0] ?? '';
    for (const name of ['partner_webhook_endpoints', 'partner_events', 'partner_event_deliveries',
      'partner_event_cursor_state', 'partner_capture_event()', 'partner_publish_events()',
      'partner_event_worker_organizations(uuid,integer)', 'partner_event_catalogue_ready()',
      'authorizing_api_key_id', 'partner_message_event', 'partner_connection_event', 'partner_meta_connection_event']) {
      expect(sql).toContain(name);
    }
  });
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
    expect(sql).toContain('lifecycle_deletions');
    expect(sql).toContain('support_tickets');
    expect(sql).toContain('support_messages');
    expect(sql).toContain('flow_executor_cutovers_drain_proof');
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

  it('fails closed when private lifecycle coverage is absent despite valid structural objects', async () => {
    for (const rows of [[{ ready: false }], [{ ready: null }], []]) {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [{ ready: true }] })
        .mockResolvedValueOnce({ rows });
      expect(await probeRequiredRuntimeSchema(query)).toBe(false);
    }
  });
});
