import type { MembershipRole, MembershipStatus } from './repository.js';

export interface MembershipActor {
  organizationId: string;
  userId: string;
}

export type MembershipCommand =
  | Readonly<{ type: 'SET_ROLE'; userId: string; role: MembershipRole; requestId: string }>
  | Readonly<{ type: 'REMOVE'; userId: string; requestId: string }>;

interface MembershipRecord {
  organizationId: string;
  userId: string;
  role: MembershipRole;
  status: MembershipStatus;
}

export interface MembershipServiceDependencies<Transaction> {
  runInOrganizationTransaction<T>(
    organizationId: string,
    operation: (transaction: Transaction) => Promise<T>,
  ): Promise<T>;
  findMembershipForUpdate(
    transaction: Transaction,
    organizationId: string,
    userId: string,
  ): Promise<MembershipRecord | null>;
  countActiveOwners(transaction: Transaction, organizationId: string): Promise<number>;
  setMembershipRole(
    transaction: Transaction,
    input: { organizationId: string; userId: string; role: MembershipRole },
  ): Promise<void>;
  removeMembership(
    transaction: Transaction,
    input: { organizationId: string; userId: string },
  ): Promise<void>;
  writeTenantAudit(
    transaction: Transaction,
    event: {
      type: 'MEMBERSHIP_CHANGED';
      organizationId: string;
      actorId: string;
      resourceId: string;
      requestId: string;
    },
  ): Promise<void>;
}

export type MembershipErrorCode =
  | 'MEMBERSHIP_FORBIDDEN'
  | 'MEMBERSHIP_NOT_FOUND'
  | 'OWNER_REQUIRED'
  | 'LAST_OWNER';

export class MembershipError extends Error {
  constructor(readonly code: MembershipErrorCode, message: string) {
    super(message);
    this.name = 'MembershipError';
  }
}

function isLastOwnerConstraint(error: unknown): boolean {
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate?.code === '23514' && candidate.constraint === 'organizations_require_owner';
}

export function createMembershipService<Transaction>(
  dependencies: MembershipServiceDependencies<Transaction>,
) {
  return {
    async changeMembership(actor: MembershipActor, command: MembershipCommand): Promise<void> {
      try {
        await dependencies.runInOrganizationTransaction(
          actor.organizationId,
          async (transaction) => {
            const actorMembership = await dependencies.findMembershipForUpdate(
              transaction,
              actor.organizationId,
              actor.userId,
            );
            if (
              !actorMembership
              || actorMembership.status !== 'ACTIVE'
              || (actorMembership.role !== 'OWNER' && actorMembership.role !== 'ADMIN')
            ) {
              throw new MembershipError(
                'MEMBERSHIP_FORBIDDEN',
                'The actor cannot manage memberships',
              );
            }

            const target = actor.userId === command.userId
              ? actorMembership
              : await dependencies.findMembershipForUpdate(
                transaction,
                actor.organizationId,
                command.userId,
              );
            if (!target) {
              throw new MembershipError('MEMBERSHIP_NOT_FOUND', 'Membership was not found');
            }

            const changesOwnership = target.role === 'OWNER'
              || (command.type === 'SET_ROLE' && command.role === 'OWNER');
            if (changesOwnership && actorMembership.role !== 'OWNER') {
              throw new MembershipError(
                'OWNER_REQUIRED',
                'Only an OWNER can change ownership',
              );
            }

            const removesActiveOwner = target.role === 'OWNER'
              && target.status === 'ACTIVE'
              && (command.type === 'REMOVE'
                || (command.type === 'SET_ROLE' && command.role !== 'OWNER'));
            if (
              removesActiveOwner
              && await dependencies.countActiveOwners(transaction, actor.organizationId) <= 1
            ) {
              throw new MembershipError(
                'LAST_OWNER',
                'An organization must retain at least one active OWNER',
              );
            }

            if (command.type === 'REMOVE') {
              await dependencies.removeMembership(transaction, {
                organizationId: actor.organizationId,
                userId: command.userId,
              });
            } else {
              await dependencies.setMembershipRole(transaction, {
                organizationId: actor.organizationId,
                userId: command.userId,
                role: command.role,
              });
            }

            await dependencies.writeTenantAudit(transaction, {
              type: 'MEMBERSHIP_CHANGED',
              organizationId: actor.organizationId,
              actorId: actor.userId,
              resourceId: command.userId,
              requestId: command.requestId,
            });
          },
        );
      } catch (error) {
        if (isLastOwnerConstraint(error)) {
          throw new MembershipError(
            'LAST_OWNER',
            'An organization must retain at least one active OWNER',
          );
        }
        throw error;
      }
    },
  };
}
