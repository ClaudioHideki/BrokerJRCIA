import type { HumanTarget, SetupCheck, SetupReadiness } from '@jrc/contracts';
import { hashIdempotencyRequest } from '../instances/idempotency.js';

export interface SetupSnapshot {
  organizationId: string; provider: 'QR' | 'META'; publicChannelId: string | null; channelId: string | null;
  connected: boolean; identity: { fingerprint: string; revision: number | string; confirmed: boolean } | null;
  destination: { origin: string; accountId: number; inboxId: number; integrationId: string;
    destinationRevision: number; credentialRevision: number; ready: boolean } | null;
  agents: { selected: number[]; eligible: number[]; targetValid: boolean; target?: HumanTarget };
  flow: { id: string; version: number; checksum: string; published: boolean; valid: boolean;
    dependencies: Array<{ id: string; version: number; checksum: string }> } | null;
  owner: { revision: number; automationId: string | null; version: number | null; executor?: 'BROKER' | 'EXTERNAL' | 'NONE' };
}
export function evaluateSetupReadiness(snapshot: SetupSnapshot): SetupReadiness {
  const checks: SetupCheck[] = [];
  const add = (code: string, title: string, passed: boolean, actionHref: string) => {
    checks.push({ code, title, state: passed ? 'PASS' : 'ACTION_REQUIRED', actionHref });
  };
  add('CHANNEL_SELECTED', 'Selecione uma conexão desta empresa.', Boolean(snapshot.publicChannelId && snapshot.channelId), '/channels');
  add('TRANSPORT_CONNECTED', 'Conecte o WhatsApp e confira a identidade do número.', snapshot.connected && Boolean(snapshot.identity?.confirmed), '/channels');
  add('DESTINATION_READY', 'Vincule uma caixa na instalação e conta corretas do JRC.', Boolean(snapshot.destination?.ready), '/integracoes');
  add('AGENTS_READY', 'Selecione atendentes participantes da caixa e um destino humano elegível.',
    snapshot.agents.selected.length > 0 && snapshot.agents.selected.every(id => snapshot.agents.eligible.includes(id)) && snapshot.agents.targetValid, '/integracoes');
  add('FLOW_READY', 'Publique o robô e resolva suas dependências e referências locais.', Boolean(snapshot.flow?.published && snapshot.flow.valid), '/automations');
  // Ownership is checked by CAS for each mutation. A deliberate test cutover does
  // not invalidate an otherwise identical number/destination/flow configuration.
  const { owner: _owner, ...configuration } = snapshot;
  const canonical = { ...configuration,
    agents: { ...configuration.agents, selected: [...configuration.agents.selected].sort((a, b) => a - b), eligible: [...configuration.agents.eligible].sort((a, b) => a - b) },
    flow: configuration.flow ? { ...configuration.flow, dependencies: [...configuration.flow.dependencies].sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version) } : null,
  };
  return { checkedAt: new Date().toISOString(), readyForTest: checks.every(check => check.state === 'PASS'), checks, owner: { ...snapshot.owner },
    fingerprint: snapshot.channelId && snapshot.destination && snapshot.flow && snapshot.identity ? hashIdempotencyRequest(canonical) : null };
}
