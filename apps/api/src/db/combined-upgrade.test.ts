import { describe, expect, it } from 'vitest';
import { compareMigrationStatus, loadExpectedMigrations } from './schema-status.js';

describe('combined URA and password reset upgrade', () => {
  it('requires both patches before declaring the approved baseline current', async () => {
    const expected = await loadExpectedMigrations();
    const baseline = expected.slice(0, 41);
    expect(compareMigrationStatus(expected, baseline)).toMatchObject({
      state: 'PENDING', compatible: false,
      pending: ['0042_native_handoff_operations', '0043_user_password_reset', '0044_attendance_resume_operations', '0045_local_attendance_directory','0046_central_transport','0047_central_dispatch','0048_central_cutover','0049_qr_outbound_observations','0050_whatsapp_group_catalog','0051_whatsapp_group_events','0052_durable_private_media'],
    });
  });

  it('rejects an independently applied reset instead of hiding the missing URA migration', async () => {
    const expected = await loadExpectedMigrations();
    const reset = expected.find(entry => entry.name === '0043_user_password_reset');
    expect(reset).toBeDefined();
    expect(compareMigrationStatus(expected, [...expected.slice(0, 41), reset!])).toMatchObject({
      state: 'DIVERGED', compatible: false,
    });
  });
});
