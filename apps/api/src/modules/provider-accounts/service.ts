import type { Page, ProviderAccount, ProviderKind } from '@jrc/contracts';

import type { TenantTransaction } from '../../db/tenant-transaction.js';
import type {
  ProviderAccountCursor,
  ProviderAccountListRow,
  ProviderAccountRepository,
} from './repository.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ProviderAccountService {
  listProviderAccounts(
    organizationId: string,
    input: { limit: number; provider?: ProviderKind; cursor?: string },
  ): Promise<Page<ProviderAccount>>;
}

export interface ProviderAccountServiceDependencies {
  repository: ProviderAccountRepository;
  runInOrganizationTransaction<T>(
    organizationId: string,
    operation: (transaction: TenantTransaction) => Promise<T>,
  ): Promise<T>;
}

export class ProviderAccountServiceError extends Error {
  constructor(
    readonly code: 'INVALID_CURSOR' | 'CURSOR_NOT_FOUND',
    readonly status: 400 | 404,
  ) {
    super(code);
    this.name = 'ProviderAccountServiceError';
  }
}

function publicAccount(row: ProviderAccountListRow): ProviderAccount {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    createdAt: row.createdAt.toISOString(),
  };
}

function encodeCursor(row: ProviderAccountListRow, provider: ProviderKind | undefined): string {
  return Buffer.from(JSON.stringify({
    organizationId: row.organizationId,
    provider: provider ?? null,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
  }), 'utf8').toString('base64url');
}

function decodeCursor(
  value: string,
  organizationId: string,
  provider: ProviderKind | undefined,
): ProviderAccountCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      parsed === null
      || Array.isArray(parsed)
      || Object.keys(parsed).sort().join(',') !== 'createdAt,id,organizationId,provider'
      || typeof parsed.organizationId !== 'string'
      || (parsed.provider !== null && parsed.provider !== 'BAILEYS' && parsed.provider !== 'META')
      || typeof parsed.createdAt !== 'string'
      || !Number.isFinite(Date.parse(parsed.createdAt))
      || typeof parsed.id !== 'string'
      || !UUID_PATTERN.test(parsed.id)
    ) throw new Error('invalid');
    if (parsed.organizationId !== organizationId) {
      throw new ProviderAccountServiceError('CURSOR_NOT_FOUND', 404);
    }
    if (parsed.provider !== (provider ?? null)) {
      throw new ProviderAccountServiceError('INVALID_CURSOR', 400);
    }
    return {
      organizationId,
      provider: parsed.provider as ProviderKind | null,
      createdAt: parsed.createdAt,
      id: parsed.id,
    };
  } catch (error) {
    if (error instanceof ProviderAccountServiceError) throw error;
    throw new ProviderAccountServiceError('INVALID_CURSOR', 400);
  }
}

export function createProviderAccountService(
  dependencies: ProviderAccountServiceDependencies,
): ProviderAccountService {
  return {
    async listProviderAccounts(organizationId, input) {
      const cursor = input.cursor
        ? decodeCursor(input.cursor, organizationId, input.provider)
        : null;
      const rows = await dependencies.runInOrganizationTransaction(
        organizationId,
        (transaction) => dependencies.repository.list(
          transaction,
          organizationId,
          input.provider ?? null,
          input.limit + 1,
          cursor,
        ),
      );
      const selected = rows.slice(0, input.limit);
      const hasNextPage = rows.length > input.limit;
      return {
        data: selected.map(publicAccount),
        pageInfo: {
          hasNextPage,
          nextCursor: hasNextPage && selected.length > 0
            ? encodeCursor(selected[selected.length - 1]!, input.provider)
            : null,
        },
      };
    },
  };
}
