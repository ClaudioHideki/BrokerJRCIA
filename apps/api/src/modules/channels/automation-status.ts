import { AUTOMATION_ORIGIN, type ChannelV1 } from '@jrc/contracts';

export interface ChannelAutomationRow {
  bot_public_id: string | null;
  bot_origin_reference: string | null;
  automation_binding_status?: string | null;
  flow_published_version: number | null;
  flow_enabled: boolean | null;
}

/** Display status is not an authorization proof that routing is absent. */
export function channelAutomationStatus(row: ChannelAutomationRow): ChannelV1['automationStatus'] {
  if (!row.bot_public_id) return 'UNBOUND';
  if (row.bot_origin_reference === AUTOMATION_ORIGIN) return row.automation_binding_status === 'ACTIVE' ? 'ACTIVE'
    : row.automation_binding_status === 'PAUSED' ? 'PAUSED' : 'UNBOUND';
  if (row.bot_origin_reference !== 'jrc-flows-native') return 'ACTIVE';
  if (!row.flow_published_version) return 'DRAFT';
  return row.flow_enabled === false ? 'PAUSED' : 'ACTIVE';
}

export function channelRoutingState(row: {
  integration_status: string; bot_public_id: string | null; bot_origin_reference: string | null;
  owner_executor: string | null; owner_revision: number | null; automation_binding_status: string | null;
  live_routing: boolean; deleting_at: Date | string | null;
  complete_snapshot?: boolean;
  remote_bot_present?: boolean;
}): 'NONE' | 'ROUTED' | 'UNKNOWN' {
  if (row.integration_status !== 'READY' || row.deleting_at) return 'UNKNOWN';
  if (row.bot_public_id || row.bot_origin_reference || row.automation_binding_status || row.live_routing || row.remote_bot_present ||
      ['BROKER', 'EXTERNAL'].includes(row.owner_executor ?? '')) return 'ROUTED';
  if (!row.complete_snapshot) return 'UNKNOWN';
  // Fresh channels do not have an owner row until their first ownership transition.
  // Absence is proven by the complete canonical scope and all live routing stores, not that missing row alone.
  if (row.owner_executor === null && row.owner_revision === null) return 'NONE';
  return row.owner_executor === 'NONE' && Number.isSafeInteger(row.owner_revision) && row.owner_revision! >= 0 ? 'NONE' : 'UNKNOWN';
}
