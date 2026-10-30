import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { RUNTIME_SCHEMA_BASELINE, probeRequiredRuntimeSchema } from '../../src/db/runtime-schema.js';
import {auditCorrectionsRuntimeSql} from '../../src/db/audit-corrections-runtime-schema.js';
import {getTableConfig} from 'drizzle-orm/pg-core';
import {instances,partnerEventDeliveries,mediaCustodyReceipts} from '../../src/db/schema.js';

describe('phase 2 schema compatibility contract', () => {
  it('registers the three additive migrations in order without changing the historical journal', async () => {
    const journal = JSON.parse(await readFile('apps/api/drizzle/migrations/meta/_journal.json', 'utf8'));
    expect(journal.entries.slice(-3).map((entry: { tag: string }) => entry.tag))
      .toEqual(['0075_media_custody', '0076_qr_connection_watermark', '0077_partner_delivery_replay']);
    expect(RUNTIME_SCHEMA_BASELINE).toBe('0077_partner_delivery_replay');
  });
  it('checks custody, clock, redrive and their lifecycle catalogue before reporting readiness', async () => {
    const queries: string[] = [];
    expect(await probeRequiredRuntimeSchema(async sql => { queries.push(sql); return { rows: [{ ready: true }] }; })).toBe(true);
    for (const relation of ['media_custody_receipts', 'connection_observed_at', 'partner_delivery_replays', 'partner_replay_delivery'])
      expect(queries[0]!.includes(relation), relation).toBe(true);
    expect(queries[1]).toContain('audit_corrections_catalogue_ready');
  });
  it('guards against conditional triggers and column-grant drift in the structural probe', async () => {
    expect(auditCorrectionsRuntimeSql).toContain('t.tgqual IS NULL');
    expect(auditCorrectionsRuntimeSql).toContain("t.tgattr::text=''");
    expect(auditCorrectionsRuntimeSql).toContain('has_any_column_privilege');
    expect(auditCorrectionsRuntimeSql).toContain('has_column_privilege');
  });
  it('retains the new database checks in the declarative ORM schema',()=>{
    for(const [table,names] of [
      [instances,['instances_connection_binding_fingerprint_check','instances_connection_clock_scope']],
      [partnerEventDeliveries,['partner_event_deliveries_lifetime_attempts_check','partner_event_deliveries_replay_count_check']],
      [mediaCustodyReceipts,['media_custody_receipts_storage_object_id_check']],
    ] as const)expect(getTableConfig(table).checks.map(c=>c.name)).toEqual(expect.arrayContaining([...names]));
  });
});
