import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { hashPassword } from '@jrc/security';
import { Pool } from 'pg';

import {
  countOrganizations,
  createOrganization,
  runInAdminTransaction,
  type AdminTransaction,
} from '../modules/organizations/repository.js';
import { createTenantCreator, type TenantCreateInput } from '../modules/organizations/tenant-create.js';
import { createUser, findUserByEmailForUpdate } from '../modules/users/repository.js';
import { createOwnerMembership } from '../modules/memberships/repository.js';
import { ensureLogicalBaileysAccount } from '../modules/provider-accounts/repository.js';
import { writeTenantAudit } from '../modules/audit/audit.js';
import type { TenantTransaction } from '../db/tenant-transaction.js';
import { createAdministrativeCredentialVerifier, readSecret } from './secure-input.js';

interface TenantCreateCommandOptions {
  argv?: string[];
  environment?: NodeJS.ProcessEnv;
  readSecretValue?: (prompt: string) => Promise<string>;
  writeOutput?: (value: string) => void;
}

function valueFor(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing required option ${name}`);
  }
  return value;
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export async function runTenantCreateCommand(
  options: TenantCreateCommandOptions = {},
): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  const environment = options.environment ?? process.env;
  const promptSecret = options.readSecretValue ?? readSecret;
  const writeOutput = options.writeOutput ?? ((value: string) => process.stdout.write(`${value}\n`));
  if (argv.some((argument) =>
    argument === '--owner-password'
    || argument.startsWith('--owner-password=')
    || argument === '--administrative-credential'
    || argument.startsWith('--administrative-credential='))) {
    throw new Error('Credentials must be supplied through secure input, never command arguments');
  }

  const ownerMode = valueFor(argv, '--owner-mode');
  if (ownerMode !== 'CREATE_NEW' && ownerMode !== 'LINK_EXISTING') {
    throw new Error('--owner-mode must be CREATE_NEW or LINK_EXISTING');
  }
  const administrativeCredential = await promptSecret('Administrative credential: ');
  const expectedCredential = requiredEnvironment(environment, 'JRC_TENANT_ADMIN_CREDENTIAL');
  const pool = new Pool({
    connectionString: requiredEnvironment(environment, 'DATABASE_ADMIN_URL'),
    max: 4,
  });
  try {
    const createTenant = createTenantCreator<AdminTransaction>({
      runInAdminTransaction: (operation) => runInAdminTransaction(pool, operation),
      verifyAdministrativeCredential: createAdministrativeCredentialVerifier(expectedCredential),
      hashPassword,
      countOrganizations,
      findUserByEmailForUpdate,
      createOrganization,
      createUser,
      createOwnerMembership,
      ensureLogicalBaileysAccount,
      writeTenantAudit: async (transaction, event) => {
        await writeTenantAudit(transaction as unknown as TenantTransaction, event);
      },
    });
    const common = {
      administrativeCredential,
      organizationName: valueFor(argv, '--organization-name'),
      organizationSlug: valueFor(argv, '--organization-slug'),
      ownerEmail: valueFor(argv, '--owner-email'),
      requestId: randomUUID(),
    };
    let input: TenantCreateInput;
    if (ownerMode === 'CREATE_NEW') {
      input = {
        ...common,
        ownerMode,
        ownerPassword: await promptSecret('Owner password: '),
      };
    } else {
      input = {
        ...common,
        ownerMode,
        confirmLinkExisting: argv.includes('--confirm-link-existing'),
      };
    }
    const result = await createTenant(input);
    writeOutput(JSON.stringify(result));
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  runTenantCreateCommand().catch((error: unknown) => {
    const code = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : 'TENANT_CREATE_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
