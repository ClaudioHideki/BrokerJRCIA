import { validateCanonicalOnboardingInput } from './onboarding-input.js';

type UserStatus = 'ACTIVE' | 'DISABLED';

interface TenantCreateBaseInput {
  administrativeCredential: string;
  organizationName: string;
  organizationSlug: string;
  ownerEmail: string;
  requestId: string;
}

export interface CreateNewOwnerInput extends TenantCreateBaseInput {
  ownerMode: 'CREATE_NEW';
  ownerPassword: string;
}

export interface LinkExistingOwnerInput extends TenantCreateBaseInput {
  ownerMode: 'LINK_EXISTING';
  confirmLinkExisting: boolean;
  ownerPassword?: never;
}

export type TenantCreateInput = CreateNewOwnerInput | LinkExistingOwnerInput;

export interface TenantCreateResult {
  organizationId: string;
  ownerUserId: string;
  providerAccountId: string;
}

interface ExistingUser {
  id: string;
  email: string;
  status: UserStatus;
  passwordHash: string;
}

export interface TenantCreateDependencies<Transaction> {
  runInAdminTransaction<T>(operation: (transaction: Transaction) => Promise<T>): Promise<T>;
  verifyAdministrativeCredential(credential: string): Promise<boolean>;
  hashPassword(password: string): Promise<string>;
  countOrganizations(transaction: Transaction): Promise<number>;
  findUserByEmailForUpdate(transaction: Transaction, email: string): Promise<ExistingUser | null>;
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
  writeTenantAudit(
    transaction: Transaction,
    event: {
      type: 'TENANT_CREATED';
      organizationId: string;
      resourceId: string;
      requestId: string;
    },
  ): Promise<void>;
}

export type TenantCreateErrorCode =
  | 'INVALID_OWNER_MODE'
  | 'INVALID_TENANT_INPUT'
  | 'ADMINISTRATIVE_CREDENTIAL_REQUIRED'
  | 'ADMINISTRATIVE_CREDENTIAL_INVALID'
  | 'BOOTSTRAP_REQUIRED'
  | 'OWNER_EMAIL_ALREADY_EXISTS'
  | 'OWNER_USER_NOT_FOUND'
  | 'OWNER_USER_NOT_ACTIVE'
  | 'LINK_EXISTING_CONFIRMATION_REQUIRED'
  | 'LINK_EXISTING_PASSWORD_NOT_ALLOWED'
  | 'ORGANIZATION_SLUG_ALREADY_EXISTS';

export class TenantCreateError extends Error {
  constructor(readonly code: TenantCreateErrorCode, message: string) {
    super(message);
    this.name = 'TenantCreateError';
  }
}

interface PostgreSqlErrorLike {
  code?: unknown;
  constraint?: unknown;
}

function mapDatabaseConflict(error: unknown): never {
  const candidate = error as PostgreSqlErrorLike;
  if (candidate?.code === '23505') {
    if (candidate.constraint === 'users_email_unique') {
      throw new TenantCreateError(
        'OWNER_EMAIL_ALREADY_EXISTS',
        'The requested owner email is already registered',
      );
    }
    if (candidate.constraint === 'organizations_slug_unique') {
      throw new TenantCreateError(
        'ORGANIZATION_SLUG_ALREADY_EXISTS',
        'The requested organization slug is already registered',
      );
    }
  }
  throw error;
}

export function createTenantCreator<Transaction>(
  dependencies: TenantCreateDependencies<Transaction>,
) {
  return async function createTenant(input: TenantCreateInput): Promise<TenantCreateResult> {
    if (input.ownerMode !== 'CREATE_NEW' && input.ownerMode !== 'LINK_EXISTING') {
      throw new TenantCreateError(
        'INVALID_OWNER_MODE',
        'ownerMode must be CREATE_NEW or LINK_EXISTING',
      );
    }
    const canonicalInput = validateCanonicalOnboardingInput({
      organizationName: input.organizationName,
      organizationSlug: input.organizationSlug,
      email: input.ownerEmail,
      requestId: input.requestId,
      ...(input.ownerMode === 'CREATE_NEW' ? { password: input.ownerPassword } : {}),
    });
    if (!canonicalInput || (input.ownerMode === 'CREATE_NEW' && !canonicalInput.password)) {
      throw new TenantCreateError(
        'INVALID_TENANT_INPUT',
        'Tenant input is invalid',
      );
    }
    if (input.ownerMode === 'LINK_EXISTING') {
      if (Object.prototype.hasOwnProperty.call(input, 'ownerPassword')) {
        throw new TenantCreateError(
          'LINK_EXISTING_PASSWORD_NOT_ALLOWED',
          'LINK_EXISTING does not accept an owner password',
        );
      }
      if (input.confirmLinkExisting !== true) {
        throw new TenantCreateError(
          'LINK_EXISTING_CONFIRMATION_REQUIRED',
          'Explicit confirmation is required to link an existing owner',
        );
      }
    }
    if (input.administrativeCredential.trim().length === 0) {
      throw new TenantCreateError(
        'ADMINISTRATIVE_CREDENTIAL_REQUIRED',
        'An administrative credential is required',
      );
    }
    if (!await dependencies.verifyAdministrativeCredential(input.administrativeCredential)) {
      throw new TenantCreateError(
        'ADMINISTRATIVE_CREDENTIAL_INVALID',
        'The administrative credential is invalid',
      );
    }

    try {
      return await dependencies.runInAdminTransaction(async (transaction) => {
        if (await dependencies.countOrganizations(transaction) === 0) {
          throw new TenantCreateError(
            'BOOTSTRAP_REQUIRED',
            'Initial tenant bootstrap must be completed first',
          );
        }

        const ownerEmail = canonicalInput.email;
        const existingUser = await dependencies.findUserByEmailForUpdate(transaction, ownerEmail);
        let owner: { id: string };

        if (input.ownerMode === 'CREATE_NEW') {
          if (existingUser) {
            throw new TenantCreateError(
              'OWNER_EMAIL_ALREADY_EXISTS',
              'The requested owner email is already registered',
            );
          }
          const ownerPassword = canonicalInput.password;
          if (ownerPassword === undefined) {
            throw new TenantCreateError('INVALID_TENANT_INPUT', 'Tenant input is invalid');
          }
          const passwordHash = await dependencies.hashPassword(ownerPassword);
          const organization = await dependencies.createOrganization(transaction, {
            name: canonicalInput.organizationName,
            slug: canonicalInput.organizationSlug,
          });
          owner = await dependencies.createUser(transaction, {
            email: ownerEmail,
            passwordHash,
          });
          return finishTenantCreation(
            dependencies,
            transaction,
            canonicalInput.requestId,
            organization.id,
            owner.id,
          );
        }

        if (!existingUser) {
          throw new TenantCreateError(
            'OWNER_USER_NOT_FOUND',
            'The requested owner user does not exist',
          );
        }
        if (existingUser.status !== 'ACTIVE') {
          throw new TenantCreateError(
            'OWNER_USER_NOT_ACTIVE',
            'The requested owner user is not active',
          );
        }
        owner = existingUser;
        const organization = await dependencies.createOrganization(transaction, {
          name: canonicalInput.organizationName,
          slug: canonicalInput.organizationSlug,
        });
        return finishTenantCreation(
          dependencies,
          transaction,
          canonicalInput.requestId,
          organization.id,
          owner.id,
        );
      });
    } catch (error) {
      return mapDatabaseConflict(error);
    }
  };
}

async function finishTenantCreation<Transaction>(
  dependencies: TenantCreateDependencies<Transaction>,
  transaction: Transaction,
  requestId: string,
  organizationId: string,
  ownerUserId: string,
): Promise<TenantCreateResult> {
  await dependencies.createOwnerMembership(transaction, { organizationId, userId: ownerUserId });
  const providerAccount = await dependencies.ensureLogicalBaileysAccount(
    transaction,
    organizationId,
  );
  await dependencies.writeTenantAudit(transaction, {
    type: 'TENANT_CREATED',
    organizationId,
    resourceId: organizationId,
    requestId,
  });
  return { organizationId, ownerUserId, providerAccountId: providerAccount.id };
}
