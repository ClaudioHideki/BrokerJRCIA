import { describe, expect, it } from 'vitest';
import { readdir } from 'node:fs/promises';
import { validateRepositoryBaseline } from '../scripts/check-repository-baseline.mjs';

describe('repository baseline', () => {
  it('contains governance, environment, and architecture files', async () => {
    const result = await validateRepositoryBaseline(process.cwd());
    expect(result.missing).toEqual([]);
    expect(result.forbiddenTrackedFiles).toEqual([]);
  });

  it('contains the current migration chain and one authoritative root manifest', async () => {
    const migrations = (await readdir('apps/api/drizzle/migrations'))
      .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
      .sort();
    const rootManifests = (await readdir('.'))
      .filter((name) => /manifest.*sha256|sha256.*manifest/iu.test(name))
      .sort();

    expect(migrations.slice(-30)).toEqual([
      '0043_user_password_reset.sql',
      '0044_attendance_resume_operations.sql',
      '0045_local_attendance_directory.sql',
      '0046_central_transport.sql',
      '0047_central_dispatch.sql',
      '0048_central_cutover.sql',
      '0049_qr_outbound_observations.sql',
      '0050_whatsapp_group_catalog.sql',
      '0051_whatsapp_group_events.sql',
      '0052_durable_private_media.sql',
      '0053_flow_delegation.sql',
      '0054_whatsapp_group_automation.sql',
      '0055_complete_native.sql',
      '0056_evolution_engine_fleet.sql',
      '0057_automation_ai_budget.sql',
      '0058_automation_conversation_media.sql',
      '0059_whatsapp_group_central.sql',
      '0060_consolidated_runtime_integrity.sql',
      '0061_automation_input_timeout.sql',
      '0062_nico_takeover_operations.sql',
      '0063_conversation_effect_protocol.sql',
      '0064_native_flow_guard_coverage.sql',
      '0065_qr_identity_pending.sql',
      '0066_physical_conversation_cycles.sql',
      '0067_history_import_ledger.sql',
      '0068_flow_domain_commands.sql',
      '0069_meta_waba_ownership.sql',
      '0070_partner_events.sql',
      '0071_partner_messaging_authority.sql',
      '0072_chatwoot_campaign_intents.sql',
    ]);
    expect(rootManifests).toEqual(['MANIFESTO_ARQUIVOS_SHA256.txt']);
  });
});
