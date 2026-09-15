import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

import type { QueryResultRow } from 'pg';

import { ConnectionActionSchema, type ConnectionAction } from '@jrc/providers';

import type { TenantTransaction } from '../../db/tenant-transaction.js';

const ALGORITHM = 'AES-256-GCM';
const CIPHER = 'aes-256-gcm';
const DEFAULT_TTL_MS = 60_000;

type PersistedConnectionAction = Exclude<ConnectionAction, { type: 'NONE' }>;

interface ChallengeDatabaseRow extends QueryResultRow {
  algorithm: string;
  ciphertext: string;
  nonce: string;
  authTag: string;
}

export interface ChallengeStore {
  store(transaction: TenantTransaction, input: {
    organizationId: string;
    instanceId: string;
    operationId: string;
    action: PersistedConnectionAction;
  }): Promise<string>;
  consume(transaction: TenantTransaction, input: {
    organizationId: string;
    instanceId: string;
    operationId: string;
    challengeId: string;
  }): Promise<PersistedConnectionAction | null>;
}

export interface ChallengeStoreOptions {
  encryptionSecret: string;
  now?: () => Date;
  ttlMs?: number;
}

export class ChallengeStoreError extends Error {
  readonly code = 'INVALID_CHALLENGE' as const;

  constructor() {
    super('INVALID_CHALLENGE');
    this.name = 'ChallengeStoreError';
  }
}

function deriveKey(secret: string): Buffer {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Challenge encryption secret must contain at least 32 bytes');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

function additionalData(input: {
  organizationId: string;
  instanceId: string;
  operationId: string;
}): Buffer {
  return Buffer.from(`${input.organizationId}:${input.instanceId}:${input.operationId}`, 'utf8');
}

function decrypt(
  key: Buffer,
  row: ChallengeDatabaseRow,
  binding: { organizationId: string; instanceId: string; operationId: string },
): PersistedConnectionAction {
  try {
    if (row.algorithm !== ALGORITHM) throw new ChallengeStoreError();
    const decipher = createDecipheriv(
      CIPHER,
      key,
      Buffer.from(row.nonce, 'base64url'),
    );
    decipher.setAAD(additionalData(binding));
    decipher.setAuthTag(Buffer.from(row.authTag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const action = ConnectionActionSchema.parse(JSON.parse(plaintext));
    if (action.type === 'NONE') throw new ChallengeStoreError();
    return action;
  } catch {
    throw new ChallengeStoreError();
  }
}

export function createChallengeStore(options: ChallengeStoreOptions): ChallengeStore {
  const key = deriveKey(options.encryptionSecret);
  const now = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('Challenge TTL must be a positive integer');
  }

  return {
    async store(transaction, input) {
      const issuedAt = now();
      const providerExpiry = Date.parse(input.action.expiresAt);
      const localExpiry = issuedAt.getTime() + ttlMs;
      const expiresAt = new Date(Math.min(providerExpiry, localExpiry));
      if (!Number.isFinite(providerExpiry) || expiresAt <= issuedAt) {
        throw new ChallengeStoreError();
      }
      const nonce = randomBytes(12);
      const cipher = createCipheriv(CIPHER, key, nonce);
      cipher.setAAD(additionalData(input));
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(input.action), 'utf8'),
        cipher.final(),
      ]);
      const result = await transaction.query<{ id: string } & QueryResultRow>(
        `INSERT INTO connection_challenges
           (organization_id, instance_id, operation_id, challenge_type, algorithm,
            ciphertext, nonce, auth_tag, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          input.organizationId,
          input.instanceId,
          input.operationId,
          input.action.type,
          ALGORITHM,
          ciphertext.toString('base64url'),
          nonce.toString('base64url'),
          cipher.getAuthTag().toString('base64url'),
          expiresAt,
        ],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new ChallengeStoreError();
      return id;
    },

    async consume(transaction, input) {
      const consumedAt = now();
      const result = await transaction.query<ChallengeDatabaseRow>(
        `WITH claimed AS (
           UPDATE connection_challenges
              SET consumed_at = $5
            WHERE organization_id = $1 AND instance_id = $2 AND operation_id = $3
              AND id = $4 AND consumed_at IS NULL AND expires_at > $5
           RETURNING algorithm, ciphertext, nonce, auth_tag AS "authTag"
         ), expired AS (
           DELETE FROM connection_challenges
            WHERE organization_id = $1 AND instance_id = $2 AND operation_id = $3
              AND id = $4 AND consumed_at IS NULL AND expires_at <= $5
         )
         SELECT algorithm, ciphertext, nonce, "authTag" FROM claimed`,
        [
          input.organizationId,
          input.instanceId,
          input.operationId,
          input.challengeId,
          consumedAt,
        ],
      );
      const row = result.rows[0];
      return row ? decrypt(key, row, input) : null;
    },
  };
}
