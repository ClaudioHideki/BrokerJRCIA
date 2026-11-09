import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { lockOwnershipMutations, transitionChannelOwner } from '../attendance/transition.js';
import { lockAttendanceChannel } from '../attendance/repository.js';
import type { NativeSetupReaderOptions } from './native-reader.js';
import type { SetupActionPorts } from './actions.js';
import type { SetupRecord } from './repository.js';
import { setupFail, type SetupPrincipal } from './service.js';
import { assertSetupBindingScope } from './binding-scope.js';

// Hold this lock until the owner transition commits. A delayed request from an
// abandoned test cannot bind after another administrator stopped that test.
export async function assertSetupOperation(tx: TenantTransaction, org: string, id: string, lease: string) {
  const row = (await tx.query<{ data: SetupRecord }>(
    'SELECT data FROM guided_setup_operations WHERE organization_id=$1 AND id=$2 FOR UPDATE', [org, id])).rows[0]?.data;
  if (!row || row.organizationId !== org || row.operation?.leaseToken !== lease || (row.operation.leaseExpiresAt ?? 0) <= Date.now())
    return setupFail('LEASE_LOST');
}
export function createNativeSetupOwner(options: Pick<NativeSetupReaderOptions, 'transact' | 'channels'> & {
  authorize(principal: SetupPrincipal): Promise<void>;
}): Pick<SetupActionPorts, 'readOwner' | 'deactivate' | 'assertOwner'> {
  return {
    async assertOwner(tx, principal, expected, validateConfiguration = true) {
      if (expected.organizationId !== principal.organizationId || !expected.channelId) return setupFail('SCOPE_MISMATCH');
      await lockOwnershipMutations(tx, principal.organizationId);
      await lockAttendanceChannel(tx, principal.organizationId, expected.channelId);
      await options.authorize(principal);
      const owner = (await tx.query<Awaited<ReturnType<SetupActionPorts['readOwner']>>['owner']>(
        'SELECT revision,executor,automation_id AS "automationId",version FROM attendance_owners WHERE organization_id=$1 AND channel_id=$2',
        [principal.organizationId, expected.channelId])).rows[0];
      if (!owner || owner.revision !== expected.owner.revision || owner.automationId !== expected.owner.automationId || owner.version !== expected.owner.version || owner.executor !== expected.owner.executor)
        return setupFail('OWNER_CHANGED');
      if (validateConfiguration) await assertSetupBindingScope(tx, principal.organizationId, expected);
    },
    async readOwner(principal, selection) {
      await options.authorize(principal);
      if (!selection.channelId) return setupFail('CHANNEL_SCOPE_MISMATCH');
      const channel = await options.channels.get(principal.organizationId, selection.channelId);
      if (channel.organizationId !== principal.organizationId || channel.provider !== selection.transport || !channel.messagingChannelId)
        return setupFail('CHANNEL_SCOPE_MISMATCH');
      const channelId = channel.messagingChannelId;
      return options.transact(principal.organizationId, async tx => ({ channelId,
        owner: (await tx.query<Awaited<ReturnType<SetupActionPorts['readOwner']>>['owner']>(
          'SELECT revision,executor,automation_id AS "automationId",version FROM attendance_owners WHERE organization_id=$1 AND channel_id=$2',
          [principal.organizationId, channelId])).rows[0] ?? { revision: 0, executor: 'NONE', automationId: null, version: null } }));
    },
    async deactivate(principal, input) {
      await options.authorize(principal);
      return options.transact(principal.organizationId, async tx => {
        await lockOwnershipMutations(tx, principal.organizationId);
        await lockAttendanceChannel(tx, principal.organizationId, input.channelId);
        await options.authorize(principal);
        await assertSetupOperation(tx, principal.organizationId, input.setupId, input.leaseToken);
        const result = await transitionChannelOwner(tx, principal.organizationId, { channelId: input.channelId,
          botPublicId: null, botOriginReference: null, expectedOwnerRevision: input.expectedOwnerRevision });
        return { ownerRevision: result.ownerRevision };
      });
    },
  };
}
