import type { RandomBytesSource } from '@jrc/security';
import {
  createOrganizationApiKey,
  parseOrganizationApiKey,
  verifyApiKey,
} from '@jrc/security';
import type { ApiKeyScope, IssueApiKeyRequest, Page } from '@jrc/contracts';

import type { TenantTransaction } from '../../db/tenant-transaction.js';
import type { TenantAuditEvent } from '../audit/audit.js';

export interface ApiKeyRow {
  id: string;
  organizationId: string;
  name: string;
  prefix: string;
  keyHmac: string;
  scopes: ApiKeyScope[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export type ApiKeyInsert = Omit<ApiKeyRow, 'id' | 'createdAt' | 'revokedAt' | 'lastUsedAt'>;

export interface ApiKeyCursor {
  organizationId: string;
  createdAt: string;
  id: string;
}

export interface ApiKeyRepository {
  insert(transaction: TenantTransaction, input: ApiKeyInsert): Promise<ApiKeyRow>;
  list(
    transaction: TenantTransaction,
    organizationId: string,
    limit: number,
    cursor: ApiKeyCursor | null,
  ): Promise<ApiKeyRow[]>;
  revoke(
    transaction: TenantTransaction,
    organizationId: string,
    id: string,
    revokedAt: Date,
  ): Promise<ApiKeyRow | null>;
  findActiveByPrefix(
    transaction: TenantTransaction,
    organizationId: string,
    prefix: string,
  ): Promise<ApiKeyRow | null>;
  markUsed(
    transaction: TenantTransaction,
    id: string,
    usedAt: Date,
    organizationId: string,
  ): Promise<void>;
}

interface ApiKeyActorContextBase {
  organizationId: string;
  requestId: string;
}

export type ApiKeyActorContext = ApiKeyActorContextBase & (
  | Readonly<{ credentialKind: 'JWT'; actorId: string }>
  | Readonly<{ credentialKind: 'API_KEY'; actorId: null; apiKeyId: string }>
);

export interface ListApiKeysInput {
  limit: number;
  cursor?: string;
}

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface IssuedApiKeyView extends Omit<ApiKeyView, 'revokedAt' | 'lastUsedAt'> {
  secret: string;
}

export interface ApiKeyPrincipal {
  apiKeyId: string;
  organizationId: string;
  scopes: ApiKeyScope[];
}

export interface ApiKeyService {
  issueApiKey(context: ApiKeyActorContext, input: IssueApiKeyRequest): Promise<IssuedApiKeyView>;
  listApiKeys(context: ApiKeyActorContext, input: ListApiKeysInput): Promise<Page<ApiKeyView>>;
  revokeApiKey(context: ApiKeyActorContext, id: string): Promise<boolean>;
  authenticateApiKey(rawApiKey: string): Promise<ApiKeyPrincipal | null>;
}

export interface ApiKeyServiceDependencies {
  repository: ApiKeyRepository;
  hmacSecret: string;
  runInOrganizationTransaction<T>(
    organizationId: string,
    operation: (transaction: TenantTransaction) => Promise<T>,
  ): Promise<T>;
  writeAudit(transaction: TenantTransaction, event: TenantAuditEvent): Promise<void>;
  now?: () => Date;
  randomBytes?: RandomBytesSource;
}

export class ApiKeyServiceError extends Error {
  constructor(readonly code: 'INVALID_CURSOR' | 'CURSOR_NOT_FOUND' | 'INVALID_EXPIRATION') {
    super(code === 'INVALID_CURSOR'
      ? 'Invalid API key cursor'
      : code === 'CURSOR_NOT_FOUND'
        ? 'API key cursor not found'
        : 'Invalid API key expiration');
    this.name = 'ApiKeyServiceError';
  }
}

function view(row: ApiKeyRow): ApiKeyView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function encodeCursor(row: ApiKeyRow): string {
  return Buffer.from(JSON.stringify({
    organizationId: row.organizationId,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
  }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, organizationId: string): ApiKeyCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    const candidate = parsed as Record<string, unknown>;
    if (
      Object.keys(candidate).sort().join(',') !== 'createdAt,id,organizationId'
      || typeof candidate.organizationId !== 'string'
      || typeof candidate.createdAt !== 'string'
      || !Number.isFinite(Date.parse(candidate.createdAt))
      || typeof candidate.id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate.id)
    ) throw new Error();
    if (candidate.organizationId !== organizationId) {
      throw new ApiKeyServiceError('CURSOR_NOT_FOUND');
    }
    return {
      organizationId,
      createdAt: candidate.createdAt,
      id: candidate.id,
    };
  } catch (error) {
    if (error instanceof ApiKeyServiceError) throw error;
    throw new ApiKeyServiceError('INVALID_CURSOR');
  }
}

function auditActor(context: ApiKeyActorContext) {
  return context.credentialKind === 'API_KEY'
    ? {
        actorId: null,
        actorKind: 'API_KEY' as const,
        actorApiKeyId: context.apiKeyId,
      }
    : { actorId: context.actorId };
}

function isGlobalPrefixCollision(error: unknown): boolean {
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate?.code === '23505'
    && candidate.constraint === 'api_keys_prefix_global_unique';
}

export function createApiKeyService(dependencies: ApiKeyServiceDependencies): ApiKeyService {
  const now = dependencies.now ?? (() => new Date());

  return {
    async issueApiKey(context, input) {
      const expiresAt = input.expiresAt === null ? null : new Date(input.expiresAt);
      if (expiresAt && expiresAt.getTime() <= now().getTime()) {
        throw new ApiKeyServiceError('INVALID_EXPIRATION');
      }
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const credential = createOrganizationApiKey(
          context.organizationId,
          dependencies.hmacSecret,
          dependencies.randomBytes,
        );
        try {
          const created = await dependencies.runInOrganizationTransaction(
            context.organizationId,
            async (transaction) => {
              const row = await dependencies.repository.insert(transaction, {
                organizationId: context.organizationId,
                name: input.name,
                prefix: credential.prefix,
                keyHmac: credential.hmac,
                scopes: [...new Set(input.scopes)],
                expiresAt,
              });
              await dependencies.writeAudit(transaction, {
                type: 'API_KEY_ISSUED',
                organizationId: context.organizationId,
                ...auditActor(context),
                resourceId: row.id,
                requestId: context.requestId,
              });
              return row;
            },
          );
          const publicView = view(created);
          return {
            id: publicView.id,
            name: publicView.name,
            prefix: publicView.prefix,
            scopes: publicView.scopes,
            expiresAt: publicView.expiresAt,
            createdAt: publicView.createdAt,
            secret: credential.secret,
          };
        } catch (error) {
          if (!isGlobalPrefixCollision(error) || attempt === 5) throw error;
        }
      }
      throw new Error('Unreachable API key retry state');
    },

    async listApiKeys(context, input) {
      const cursor = input.cursor ? decodeCursor(input.cursor, context.organizationId) : null;
      const rows = await dependencies.runInOrganizationTransaction(
        context.organizationId,
        async (transaction) => {
          return dependencies.repository.list(
            transaction,
            context.organizationId,
            input.limit + 1,
            cursor,
          );
        },
      );
      const hasNextPage = rows.length > input.limit;
      const selected = rows.slice(0, input.limit);
      return {
        data: selected.map(view),
        pageInfo: {
          hasNextPage,
          nextCursor: hasNextPage && selected.length > 0
            ? encodeCursor(selected[selected.length - 1]!)
            : null,
        },
      };
    },

    async revokeApiKey(context, id) {
      return dependencies.runInOrganizationTransaction(context.organizationId, async (transaction) => {
        const revoked = await dependencies.repository.revoke(
          transaction,
          context.organizationId,
          id,
          now(),
        );
        if (!revoked) return false;
        await dependencies.writeAudit(transaction, {
          type: 'API_KEY_REVOKED',
          organizationId: context.organizationId,
          ...auditActor(context),
          resourceId: revoked.id,
          requestId: context.requestId,
        });
        return true;
      });
    },

    async authenticateApiKey(rawApiKey) {
      const parsed = parseOrganizationApiKey(rawApiKey);
      if (!parsed) return null;
      return dependencies.runInOrganizationTransaction(parsed.organizationId, async (transaction) => {
        const row = await dependencies.repository.findActiveByPrefix(
          transaction,
          parsed.organizationId,
          parsed.prefix,
        );
        const authenticationTime = now();
        if (
          !row
          || row.revokedAt !== null
          || (row.expiresAt !== null && row.expiresAt.getTime() <= authenticationTime.getTime())
          || !verifyApiKey(rawApiKey, row.keyHmac, dependencies.hmacSecret)
        ) return null;
        await dependencies.repository.markUsed(
          transaction,
          row.id,
          authenticationTime,
          parsed.organizationId,
        );
        return {
          apiKeyId: row.id,
          organizationId: row.organizationId,
          scopes: row.scopes,
        };
      });
    },
  };
}
