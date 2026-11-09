import { validateAutomationGraph, type AutomationGraphV1, type SetupSelection } from '@jrc/contracts';
import { matchesSetupGraphScope } from './graph-scope.js';
import type { NativeSetupReaderOptions } from './native-reader.js';
import type { SetupPrincipal } from './service.js';
import { setupFail } from './service.js';
import type { SetupSnapshot } from './readiness.js';
import type { ChatwootService } from '../integrations/chatwoot-service.js';
import type { ChatwootControlService } from '../integrations/chatwoot-control-service.js';
import type { ChatwootControlAuth } from '../integrations/chatwoot-control-auth.js';
import type { createMetaOnboardingService } from '../meta-onboarding/service.js';
import { createPostgresAutomationRepository, type AutomationRepository } from '../automations/repository.js';
import { prepareSubflowSnapshot } from '../automations/subflow-dependencies.js';
import { assertHttpQueryPolicies } from '../automations/http-query-policy.js';
import { assertAiPolicies } from '../automations/ai-policy.js';
import { assertConversationResourcePolicies } from '../automations/conversation-resources.js';
import { createHandoffReadiness } from '../attendance/handoff-readiness.js';
import { readChatwootHealth } from '../integrations/chatwoot-health.js';
import { hashIdempotencyRequest } from '../instances/idempotency.js';
import { AutomationError } from '../automations/errors.js';
import { AttendanceError } from '../attendance/types.js';
import { IntegrationError } from '../integrations/integration-error.js';

export interface NativeSetupInspectorOptions extends Omit<NativeSetupReaderOptions, 'chatwoot'> {
  chatwoot?: Pick<ChatwootService, 'attendanceCatalog' | 'status' | 'validateHumanDestination' | 'validateGuidedHumanDestination'>;
  controlAuth?: Pick<ChatwootControlAuth, 'authorize'>; control?: Pick<ChatwootControlService, 'status'>;
  meta?: Pick<ReturnType<typeof createMetaOnboardingService>, 'refresh'>; repository?: AutomationRepository;
  refreshResources?(org: string, graphs: AutomationGraphV1[]): Promise<void>;
}
export function createNativeSetupInspector(options: NativeSetupInspectorOptions) {
  const repository = options.repository ?? createPostgresAutomationRepository();
  return async (principal: SetupPrincipal, selection: SetupSelection): Promise<SetupSnapshot> => {
    const org = principal.organizationId;
    const value: SetupSnapshot = { organizationId: org, provider: selection.transport, publicChannelId: selection.channelId ?? null,
      channelId: null, connected: false, identity: null, destination: null,
      agents: { selected: selection.agentIds ?? [], eligible: [], targetValid: false,
        ...(selection.humanTarget ? { target: selection.humanTarget } : {}) }, flow: null,
      owner: { revision: 0, automationId: null, version: null, executor: 'NONE' } };
    if (!selection.channelId) return value;
    const channel = await options.channels.get(org, selection.channelId);
    if (channel.organizationId !== org || channel.provider !== selection.transport) return setupFail('CHANNEL_SCOPE_MISMATCH');
    value.channelId = channel.messagingChannelId ?? null;
    if (!value.channelId) return value;
    const canonicalId = value.channelId;
    value.owner = await options.transact(org, async tx => (await tx.query<SetupSnapshot['owner']>(
      'SELECT revision,executor,automation_id AS "automationId",version FROM attendance_owners WHERE organization_id=$1 AND channel_id=$2',
      [org, canonicalId])).rows[0] ?? value.owner);
    if (selection.integrationId && options.chatwoot) {
      const catalog = await options.chatwoot.attendanceCatalog(org, selection.integrationId);
      if (catalog.scope.organizationId !== org || catalog.scope.channelId !== canonicalId || catalog.scope.integrationId !== selection.integrationId)
        return setupFail('DESTINATION_SCOPE_MISMATCH');
      const status = await options.chatwoot.status(org), connection = status.connections.find(c => c.id === selection.integrationId);
      if (!status.baseUrl || !status.account || !connection || connection.channelId !== canonicalId || connection.inboxId !== catalog.scope.inboxId ||
        status.account.accountId !== catalog.scope.accountId || status.account.credentialVersion !== catalog.credentialRevision || status.destination?.revision !== catalog.scope.destinationRevision)
        return setupFail('DESTINATION_SCOPE_MISMATCH');
      value.destination = { origin: status.baseUrl, accountId: catalog.scope.accountId, inboxId: catalog.scope.inboxId,
        integrationId: selection.integrationId, destinationRevision: catalog.scope.destinationRevision,
        credentialRevision: catalog.credentialRevision, ready: status.account.status === 'READY' && connection.status === 'READY' };
      value.agents.eligible = catalog.agents.filter(agent => agent.inboxMember).map(agent => agent.id);
      if (selection.humanTarget) {
        try {
          if (selection.humanTarget.teamId !== null) await options.chatwoot.validateGuidedHumanDestination(catalog.scope, selection.humanTarget);
          else await options.chatwoot.validateHumanDestination(catalog.scope, selection.humanTarget);
          value.agents.targetValid = true;
        }
        catch (error) { if (!(error instanceof IntegrationError)) throw error; }
      }
      if (channel.provider === 'QR' && options.controlAuth && options.control) {
        const actor = await options.controlAuth.authorize({ kind: 'JWT', organizationId: org, actorId: principal.actorId, role: 'VIEWER' }, 'chatwoot:read', selection.integrationId);
        const live = await options.control.status(actor, selection.integrationId);
        const identity = await options.transact(org, tx => readChatwootHealth(tx, org, selection.integrationId!));
        value.connected = live.instanceStatus === 'CONNECTED';
        if (identity?.approved_fingerprint && identity.observed_fingerprint === identity.approved_fingerprint)
          value.identity = { fingerprint: identity.approved_fingerprint, revision: identity.identity_revision,
            confirmed: live.identityApproved && live.identityStatus === 'CONFIRMED' && identity.observed_connected && !identity.identity_error };
      }
    }
    if (channel.provider === 'META' && options.meta) {
      await options.meta.refresh(org, channel.providerReference.connectionId);
      const meta = await options.transact(org, async tx => (await tx.query<{
        status: string; fingerprint: string; graphVersion: string; live: boolean;
      }>(`SELECT status,encode(sha256(convert_to(phone_number_id||':'||waba_id||':'||coalesce(encrypted_token,''),'UTF8')),'hex') AS fingerprint,
        graph_version AS "graphVersion",(token_expires_at IS NULL OR token_expires_at>clock_timestamp()) AS live
        FROM meta_connections WHERE organization_id=$1 AND id=$2 AND channel_id=$3`, [org, channel.providerReference.connectionId, canonicalId])).rows[0]);
      if (meta) {
        value.connected = meta.status === 'READY' && meta.live;
        // Meta readiness_revision advances on reads; pin stable authorized assets instead.
        value.identity = { fingerprint: meta.fingerprint, revision: meta.graphVersion, confirmed: value.connected };
      }
    }
    if (selection.automationId && selection.version) {
      const flow = await options.transact(org, async tx => {
        const definition = await repository.getDefinition(tx, org, selection.automationId!);
        const root = await repository.getVersion(tx, org, selection.automationId!, selection.version!);
        if (!definition || definition.lifecycleStatus === 'ARCHIVED' || !root || root.runtimeStateVersion !== 2) return null;
        const dependencies = await prepareSubflowSnapshot(tx, org, { automationId: root.automationId, version: root.version,
          graph: root.graph, runtimeStateVersion: 2 }, repository, 'NEW');
        return { root, dependencies };
      });
      if (flow) {
        await options.refreshResources?.(org, flow.dependencies.versions.map(version => version.graph));
        await options.transact(org, async tx => {
          await assertHttpQueryPolicies(tx, org, flow.dependencies); await assertAiPolicies(tx, org, flow.dependencies);
          for (const version of flow.dependencies.versions) await assertConversationResourcePolicies(tx, org, version.automationId, [version.graph]);
        });
        let valid = validateAutomationGraph(flow.root.graph).length === 0;
        const handoffs = createHandoffReadiness({ transact: options.transact,
          ...(options.chatwoot ? { catalog: options.chatwoot.attendanceCatalog, validateTarget: options.chatwoot.validateHumanDestination } : {}) });
        for (const version of flow.dependencies.versions) {
          if (!matchesSetupGraphScope(version.graph, value)) valid = false;
          try { const prepared = await handoffs.prepare(org, version.graph, canonicalId); await options.transact(org, tx => prepared.assertCurrent(tx)); }
          catch (error) {
            if (error instanceof AutomationError || error instanceof AttendanceError || error instanceof IntegrationError) valid = false;
            else throw error;
          }
        }
        value.flow = { id: flow.root.automationId, version: flow.root.version, checksum: flow.root.checksum, published: true, valid,
          dependencies: flow.dependencies.versions.map(v => ({ id: v.automationId, version: v.version, checksum: hashIdempotencyRequest(v.graph) })) };
      }
    }
    return value;
  };
}
