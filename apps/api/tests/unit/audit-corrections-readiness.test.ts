import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { RUNTIME_SCHEMA_BASELINE, probeRequiredRuntimeSchema } from '../../src/db/runtime-schema.js';
import {auditCorrectionsRuntimeSql} from '../../src/db/audit-corrections-runtime-schema.js';
import {getTableConfig} from 'drizzle-orm/pg-core';
import {instances,partnerEventDeliveries,mediaCustodyReceipts} from '../../src/db/schema.js';

describe('phase 2 schema compatibility contract', () => {
  it('preserves the five audit migrations in their historical positions as additive migrations follow them', async () => {
    const journal = JSON.parse(await readFile('apps/api/drizzle/migrations/meta/_journal.json', 'utf8'));
    expect(journal.entries.slice(74,79).map((entry: { tag: string }) => entry.tag))
      .toEqual(['0075_media_custody', '0076_qr_connection_watermark', '0077_partner_delivery_replay', '0078_qr_origin_receipts', '0079_partner_persistence_receipts']);
    expect(RUNTIME_SCHEMA_BASELINE).toBe('0083_central_flow_media_references');
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

it('requires the exact valid immediate origin receipt primary index and tenant-scoped foreign keys',()=>{
 for(const requirement of ['i.indisprimary','i.indisunique','i.indisvalid','i.indisready','i.indimmediate','i.indpred IS NULL','i.indexprs IS NULL',
  "ARRAY['organization_id','channel_id','source_event_id']", "('organizations',ARRAY['organization_id']", "('messaging_channels',ARRAY['organization_id','channel_id']",
  "('instances',ARRAY['organization_id','instance_id']", 'c.confdeltype', 'c.confkey', 'c.conkey'])
  expect(auditCorrectionsRuntimeSql,requirement).toContain(requirement);
});
