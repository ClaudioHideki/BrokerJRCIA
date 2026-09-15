import { Pool } from 'pg';

import { hashPassword } from '@jrc/security';
import { createSecurityAuditWriter } from '../../../src/modules/audit/security-audit.js';
import { writeTenantAudit } from '../../../src/modules/audit/audit.js';
import {
  acquireBootstrapLock,
  countOrganizations,
  createOrganization,
  runInAdminTransaction,
  type AdminTransaction,
} from '../../../src/modules/organizations/repository.js';
import { createBootstrapFirstTenant } from '../../../src/modules/organizations/bootstrap.js';
import { createTenantCreator } from '../../../src/modules/organizations/tenant-create.js';
import { createUser, findUserByEmailForUpdate } from '../../../src/modules/users/repository.js';
import {
  countActiveOwners,
  createOwnerMembership,
  findMembershipForUpdate,
  removeMembership,
  setMembershipRole,
} from '../../../src/modules/memberships/repository.js';
import { createMembershipService } from '../../../src/modules/memberships/service.js';
import { ensureLogicalBaileysAccount } from '../../../src/modules/provider-accounts/repository.js';
import {
  withOrganizationTransaction,
  type TenantTransaction,
} from '../../../src/db/tenant-transaction.js';

export const ADMIN_CREDENTIAL = 'local-admin-credential-canary';

export function connectionStringForRole(connectionString: string, role: 'jrc_app'): string {
  const url = new URL(connectionString);
  url.username = role;
  url.password = '';
  return url.toString();
}

export function bootstrapDependencies(pool: Pool) {
  return {
    hashPassword,
    runInAdminTransaction: <T>(operation: (transaction: AdminTransaction) => Promise<T>) =>
      runInAdminTransaction(pool, operation),
    acquireBootstrapLock,
    countOrganizations,
    createOrganization,
    createUser,
    createOwnerMembership,
    ensureLogicalBaileysAccount,
    writeSecurityAudit: async (
      transaction: AdminTransaction,
      event: Parameters<ReturnType<typeof createSecurityAuditWriter>>[0],
    ) => createSecurityAuditWriter(transaction)(event),
  };
}

export function createRealBootstrap(pool: Pool) {
  return createBootstrapFirstTenant(bootstrapDependencies(pool));
}

export function tenantDependencies(pool: Pool) {
  return {
    runInAdminTransaction: <T>(operation: (transaction: AdminTransaction) => Promise<T>) =>
      runInAdminTransaction(pool, operation),
    verifyAdministrativeCredential: async (credential: string) => credential === ADMIN_CREDENTIAL,
    hashPassword,
    countOrganizations,
    findUserByEmailForUpdate,
    createOrganization,
    createUser,
    createOwnerMembership,
    ensureLogicalBaileysAccount,
    writeTenantAudit: async (
      transaction: AdminTransaction,
      event: Parameters<typeof writeTenantAudit>[1],
    ) => writeTenantAudit(transaction as never, event),
  };
}

export function createRealTenantCreator(pool: Pool) {
  return createTenantCreator(tenantDependencies(pool));
}

export function membershipDependencies(appPool: Pool) {
  return {
    runInOrganizationTransaction: <T>(
      organizationId: string,
      operation: (transaction: TenantTransaction) => Promise<T>,
    ) => withOrganizationTransaction(appPool, organizationId, operation),
    findMembershipForUpdate,
    countActiveOwners,
    setMembershipRole,
    removeMembership,
    writeTenantAudit,
  };
}

export function createRealMembershipService(appPool: Pool) {
  return createMembershipService(membershipDependencies(appPool));
}

export function injectFailureAfterRealCall<
  Dependencies extends object,
  Key extends keyof Dependencies,
>(dependencies: Dependencies, key: Key): Dependencies {
  const realFunction = dependencies[key];
  if (typeof realFunction !== 'function') {
    throw new Error(`Cannot inject failure into ${String(key)}`);
  }
  return {
    ...dependencies,
    [key]: async (...arguments_: unknown[]) => {
      await Reflect.apply(realFunction, dependencies, arguments_);
      throw Object.assign(new Error(`injected failure after ${String(key)}`), {
        code: 'INJECTED_FAILURE',
      });
    },
  };
}

export async function resetTask7Tables(pool: Pool): Promise<void> {
  await pool.query(
    `TRUNCATE audit_logs, security_audit_logs, provider_accounts,
              memberships, users, organizations CASCADE`,
  );
}
