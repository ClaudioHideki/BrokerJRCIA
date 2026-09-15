import type { QueryResultRow } from 'pg';

import type { AdminTransaction } from '../organizations/repository.js';

export interface User {
  id: string;
  email: string;
  status: 'ACTIVE' | 'DISABLED';
}

export interface UserWithPasswordHash extends User {
  passwordHash: string;
}

export interface CreateUserInput {
  email: string;
  passwordHash: string;
}

async function exactlyOne<T extends QueryResultRow>(
  transaction: AdminTransaction,
  text: string,
  values: unknown[],
): Promise<T> {
  const result = await transaction.query<T>(text, values);
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) {
    throw new Error(`Expected exactly one row, received ${result.rows.length}`);
  }
  return row;
}

export async function findUserByEmail(
  transaction: AdminTransaction,
  email: string,
): Promise<UserWithPasswordHash | null> {
  const result = await transaction.query<UserWithPasswordHash>(
    `SELECT id, email, status, password_hash AS "passwordHash"
       FROM users
      WHERE email = $1`,
    [email],
  );
  return result.rows[0] ?? null;
}

export async function findUserByEmailForUpdate(
  transaction: AdminTransaction,
  email: string,
): Promise<UserWithPasswordHash | null> {
  const result = await transaction.query<UserWithPasswordHash>(
    `SELECT id, email, status, password_hash AS "passwordHash"
       FROM users
      WHERE email = $1
      FOR UPDATE`,
    [email],
  );
  return result.rows[0] ?? null;
}

export async function createUser(
  transaction: AdminTransaction,
  input: CreateUserInput,
): Promise<User> {
  return exactlyOne<User>(
    transaction,
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     RETURNING id, email, status`,
    [input.email, input.passwordHash],
  );
}

export async function setUserStatus(
  transaction: AdminTransaction,
  userId: string,
  status: User['status'],
): Promise<void> {
  await transaction.query(
    'UPDATE users SET status = $2, updated_at = now() WHERE id = $1',
    [userId, status],
  );
}
