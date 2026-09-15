import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { hashPassword } from '@jrc/security';
import { Pool } from 'pg';

import {
  acquireBootstrapLock,
  countOrganizations,
  createOrganization,
  runInAdminTransaction,
  type AdminTransaction,
} from '../modules/organizations/repository.js';
import { createBootstrapFirstTenant } from '../modules/organizations/bootstrap.js';
import { createUser } from '../modules/users/repository.js';
import { createOwnerMembership } from '../modules/memberships/repository.js';
import { ensureLogicalBaileysAccount } from '../modules/provider-accounts/repository.js';
import { createSecurityAuditWriter } from '../modules/audit/security-audit.js';
import { readSecret } from './secure-input.js';

interface BootstrapCommandOptions {
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

function adminDatabaseUrl(environment: NodeJS.ProcessEnv): string {
  const value = environment.DATABASE_ADMIN_URL;
  if (!value) {
    throw new Error('DATABASE_ADMIN_URL is required');
  }
  return value;
}

export async function runBootstrapCommand(options: BootstrapCommandOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  const environment = options.environment ?? process.env;
  const promptSecret = options.readSecretValue ?? readSecret;
  const writeOutput = options.writeOutput ?? ((value: string) => process.stdout.write(`${value}\n`));
  if (argv.some((argument) => argument === '--password' || argument.startsWith('--password='))) {
    throw new Error('Passwords must be supplied through secure input, never command arguments');
  }
  const organizationName = valueFor(argv, '--organization-name');
  const organizationSlug = valueFor(argv, '--organization-slug');
  const email = valueFor(argv, '--email');
  const connectionString = adminDatabaseUrl(environment);
  const password = await promptSecret('Owner password: ');
  const pool = new Pool({ connectionString, max: 2 });
  try {
    const bootstrapFirstTenant = createBootstrapFirstTenant<AdminTransaction>({
      hashPassword,
      runInAdminTransaction: (operation) => runInAdminTransaction(pool, operation),
      acquireBootstrapLock,
      countOrganizations,
      createOrganization,
      createUser,
      createOwnerMembership,
      ensureLogicalBaileysAccount,
      writeSecurityAudit: async (transaction, event) => {
        await createSecurityAuditWriter(transaction)(event);
      },
    });
    const result = await bootstrapFirstTenant({
      organizationName,
      organizationSlug,
      email,
      password,
      requestId: randomUUID(),
    });
    writeOutput(JSON.stringify(result));
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  runBootstrapCommand().catch((error: unknown) => {
    const code = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : 'BOOTSTRAP_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
