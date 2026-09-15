import { validateCanonicalOnboardingInput } from './onboarding-input.js';

export interface BootstrapInput {
  organizationName: string;
  organizationSlug: string;
  email: string;
  password: string;
  requestId: string;
}

export interface BootstrapResult {
  organizationId: string;
  ownerUserId: string;
  providerAccountId: string;
}

export interface BootstrapDependencies<Transaction> {
  hashPassword(password: string): Promise<string>;
  runInAdminTransaction<T>(operation: (transaction: Transaction) => Promise<T>): Promise<T>;
  acquireBootstrapLock(transaction: Transaction): Promise<void>;
  countOrganizations(transaction: Transaction): Promise<number>;
  createOrganization(
    transaction: Transaction,
    input: { name: string; slug: string },
  ): Promise<{ id: string }>;
  createUser(
    transaction: Transaction,
    input: { email: string; passwordHash: string },
  ): Promise<{ id: string }>;
  createOwnerMembership(
    transaction: Transaction,
    input: { organizationId: string; userId: string },
  ): Promise<void>;
  ensureLogicalBaileysAccount(
    transaction: Transaction,
    organizationId: string,
  ): Promise<{ id: string }>;
  writeSecurityAudit(
    transaction: Transaction,
    event: { type: 'BOOTSTRAP_COMPLETED'; requestId: string },
  ): Promise<void>;
}

export class BootstrapError extends Error {
  constructor(
    readonly code: 'BOOTSTRAP_ALREADY_COMPLETED' | 'INVALID_BOOTSTRAP_INPUT',
    message: string,
  ) {
    super(message);
    this.name = 'BootstrapError';
  }
}

export function createBootstrapFirstTenant<Transaction>(
  dependencies: BootstrapDependencies<Transaction>,
) {
  return async function bootstrapFirstTenant(input: BootstrapInput): Promise<BootstrapResult> {
    const canonicalInput = validateCanonicalOnboardingInput({
      organizationName: input.organizationName,
      organizationSlug: input.organizationSlug,
      email: input.email,
      password: input.password,
      requestId: input.requestId,
    });
    const ownerPassword = canonicalInput?.password;
    if (!canonicalInput || ownerPassword === undefined) {
      throw new BootstrapError(
        'INVALID_BOOTSTRAP_INPUT',
        'Bootstrap input is invalid',
      );
    }

    return dependencies.runInAdminTransaction(async (transaction) => {
      await dependencies.acquireBootstrapLock(transaction);
      if (await dependencies.countOrganizations(transaction) !== 0) {
        throw new BootstrapError(
          'BOOTSTRAP_ALREADY_COMPLETED',
          'Initial tenant bootstrap has already been completed',
        );
      }

      const passwordHash = await dependencies.hashPassword(ownerPassword);
      const organization = await dependencies.createOrganization(transaction, {
        name: canonicalInput.organizationName,
        slug: canonicalInput.organizationSlug,
      });
      const owner = await dependencies.createUser(transaction, {
        email: canonicalInput.email,
        passwordHash,
      });
      await dependencies.createOwnerMembership(transaction, {
        organizationId: organization.id,
        userId: owner.id,
      });
      const providerAccount = await dependencies.ensureLogicalBaileysAccount(
        transaction,
        organization.id,
      );
      await dependencies.writeSecurityAudit(transaction, {
        type: 'BOOTSTRAP_COMPLETED',
        requestId: canonicalInput.requestId,
      });

      return {
        organizationId: organization.id,
        ownerUserId: owner.id,
        providerAccountId: providerAccount.id,
      };
    });
  };
}
