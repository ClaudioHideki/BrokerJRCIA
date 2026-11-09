import type { SetupSelection } from '@jrc/contracts';
import type { OrganizationTransaction } from '../../db/tenant-transaction.js';
import type { ChannelFacade } from '../channels/facade.js';
import type { ChatwootService } from '../integrations/chatwoot-service.js';
import type { AutomationService } from '../automations/service.js';
import type { AutomationPackageService } from '../automation-integrations/package-service.js';
import type { SetupPrincipal } from './service.js';
import { setupFail } from './service.js';

export interface NativeSetupReaderOptions {
  transact<T>(org: string, work: OrganizationTransaction<T>): Promise<T>;
  channels: Pick<ChannelFacade, 'get'>; automations: Pick<AutomationService, 'get' | 'versions'>;
  chatwoot?: Pick<ChatwootService, 'attendanceCatalog'>; packages?: Pick<AutomationPackageService, 'get'>;
}
export function createNativeSetupReader(options: NativeSetupReaderOptions) {
  return {
    async validateSelection(principal: SetupPrincipal, selection: SetupSelection) {
      const org = principal.organizationId;
      const channel = selection.channelId ? await options.channels.get(org, selection.channelId) : null;
      if (channel && (channel.organizationId !== org || channel.provider !== selection.transport)) return setupFail('CHANNEL_SCOPE_MISMATCH');
      if (selection.integrationId) {
        if (!options.chatwoot) return setupFail('DESTINATION_UNAVAILABLE', 503);
        const catalog = await options.chatwoot.attendanceCatalog(org, selection.integrationId);
        if (catalog.scope.organizationId !== org || catalog.scope.integrationId !== selection.integrationId ||
          channel && catalog.scope.channelId !== channel.messagingChannelId) return setupFail('DESTINATION_SCOPE_MISMATCH');
        if (selection.agentIds?.some(id => !catalog.agents.some(agent => agent.id === id))) return setupFail('AGENT_NOT_FOUND');
      } else if (selection.agentIds?.length || selection.humanTarget) return setupFail('DESTINATION_REQUIRED');
      if (selection.automationId) {
        const definition = await options.automations.get(org, selection.automationId);
        if (definition.organizationId !== org || definition.lifecycleStatus === 'ARCHIVED') return setupFail('FLOW_UNAVAILABLE');
        if (selection.version && !(await options.automations.versions(org, selection.automationId)).data.some(v => v.version === selection.version))
          return setupFail('VERSION_UNAVAILABLE');
      } else if (selection.version) return setupFail('FLOW_REQUIRED');
      if (selection.packageId) {
        if (!options.packages) return setupFail('PACKAGE_UNAVAILABLE', 503);
        const bundle = await options.packages.get(org, selection.packageId);
        if (selection.automationId && bundle.rootId !== selection.automationId) return setupFail('PACKAGE_SCOPE_MISMATCH');
      }
    },
  };
}
