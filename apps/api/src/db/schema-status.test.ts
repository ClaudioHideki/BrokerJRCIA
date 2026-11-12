import { describe, expect, it } from 'vitest';

import { compareMigrationStatus, loadExpectedMigrations } from './schema-status.js';

const expected = [
  { name: '0001_roles', hash: 'hash-1', createdAt: 1000 },
  { name: '0002_identity', hash: 'hash-2', createdAt: 2000 },
  { name: '0003_channels', hash: 'hash-3', createdAt: 3000 },
] as const;

describe('schema status read-only', () => {
  it('loads the complete migration manifest through 0089', async () => {
    const migrations = await loadExpectedMigrations();
    expect(migrations).toHaveLength(89);
    expect(migrations.slice(-15).map(entry => entry.name)).toEqual([
      '0075_media_custody', '0076_qr_connection_watermark', '0077_partner_delivery_replay', '0078_qr_origin_receipts', '0079_partner_persistence_receipts','0080_integration_failure_diagnostics','0081_automation_execution_inspection','0082_flow_execution_capability','0083_central_flow_media_references','0084_native_csat_transport','0085_guided_setup','0086_automation_box_routing','0087_history_sync','0088_history_catalogue','0089_history_materialization',
    ]);
  });
  it('keeps the previous media schema pending until all audit corrections are applied',async()=>{
    const migrations=await loadExpectedMigrations();
    expect(compareMigrationStatus(migrations,migrations.slice(0,74))).toMatchObject({state:'PENDING',compatible:false,expectedVersion:'0089_history_materialization',appliedVersion:'0074_partner_media',pending:['0075_media_custody','0076_qr_connection_watermark','0077_partner_delivery_replay','0078_qr_origin_receipts','0079_partner_persistence_receipts','0080_integration_failure_diagnostics','0081_automation_execution_inspection','0082_flow_execution_capability','0083_central_flow_media_references','0084_native_csat_transport','0085_guided_setup','0086_automation_box_routing','0087_history_sync','0088_history_catalogue','0089_history_materialization']});
  });

  it('informa a versão aplicada e migrations pendentes sem expor hashes', () => {
    expect(compareMigrationStatus(expected, [
      { hash: 'hash-1', createdAt: 1000 },
      { hash: 'hash-2', createdAt: 2000 },
    ])).toEqual({
      state: 'PENDING',
      compatible: false,
      expectedVersion: '0003_channels',
      appliedVersion: '0002_identity',
      expectedCount: 3,
      appliedCount: 2,
      pending: ['0003_channels'],
    });
  });
  it('does not approve the previous binary baseline without delivery diagnostics',async()=>{
    const migrations=await loadExpectedMigrations();
    expect(migrations.some(item=>item.name==='0080_integration_failure_diagnostics')).toBe(true);
    expect(compareMigrationStatus(migrations,migrations.slice(0,79))).toMatchObject({state:'PENDING',compatible:false,pending:expect.arrayContaining(['0080_integration_failure_diagnostics'])});
  });

  it('marca o schema atual quando o prefixo e a quantidade conferem', () => {
    expect(compareMigrationStatus(expected, expected.map(({ hash, createdAt }) => ({ hash, createdAt })))).toMatchObject({
      state: 'CURRENT',
      compatible: true,
      pending: [],
    });
  });

  it('falha fechado quando a história aplicada diverge', () => {
    expect(compareMigrationStatus(expected, [
      { hash: 'other-hash', createdAt: 1000 },
    ])).toEqual({
      state: 'DIVERGED',
      compatible: false,
      expectedVersion: '0003_channels',
      appliedVersion: null,
      expectedCount: 3,
      appliedCount: 1,
      pending: [],
    });
  });
});
