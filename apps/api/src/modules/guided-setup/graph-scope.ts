import { AutomationHandoffConfigSchema, type AutomationGraphV1 } from '@jrc/contracts';
import type { SetupSnapshot } from './readiness.js';

/** The displayed human destination must be the one the published graph actually uses. */
export function matchesSetupGraphScope(graph: AutomationGraphV1, snapshot: SetupSnapshot) {
  for (const node of graph.nodes) {
    if (node.type === 'handoff') {
      const result = AutomationHandoffConfigSchema.safeParse(node.data), destination = snapshot.destination;
      if (!result.success || result.data.handoffVersion !== 1 || !destination || !snapshot.agents.target) return false;
      const configured = result.data.destination;
      if (configured.integrationId !== destination.integrationId || configured.accountId !== destination.accountId || configured.inboxId !== destination.inboxId ||
        configured.credentialRevision !== destination.credentialRevision || configured.destinationRevision !== destination.destinationRevision ||
        result.data.target.agentId !== snapshot.agents.target.agentId || result.data.target.teamId !== snapshot.agents.target.teamId) return false;
    }
    if (node.type === 'domain' || ['tag', 'attribute', 'note', 'resolve'].includes(node.type) && node.data.conversationEffectVersion === 2 ||
      node.type === 'media' && node.data.mediaEffectVersion === 2) {
      if (node.data.channelId !== snapshot.channelId) return false;
    }
  }
  return true;
}
