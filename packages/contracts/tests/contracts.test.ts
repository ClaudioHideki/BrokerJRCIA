import { describe, expect, it } from 'vitest';

import {
  CursorPaginationQuerySchema,
  ConnectInstanceRequestSchema,
  IdempotencyHeadersSchema,
  InstanceIdParamsSchema,
  InstanceMutationResponseSchema,
  InstanceSchema,
  LoginRequestSchema,
  ProblemDetailsSchema,
  PROBLEM_CONTENT_TYPE,
  SelectOrganizationRequestSchema,
} from '../src/index.js';

describe('contratos HTTP canônicos', () => {
  it('aplica paginação padrão e aceita o intervalo de 1 a 100', () => {
    expect(CursorPaginationQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(CursorPaginationQuerySchema.parse({ limit: '1' })).toEqual({ limit: 1 });
    expect(CursorPaginationQuerySchema.parse({ limit: '100', cursor: 'next' })).toEqual({
      limit: 100,
      cursor: 'next',
    });
    expect(() => CursorPaginationQuerySchema.parse({ limit: 0 })).toThrow();
    expect(() => CursorPaginationQuerySchema.parse({ limit: 101 })).toThrow();
  });

  it('valida autenticação e identificadores UUID', () => {
    expect(LoginRequestSchema.parse({ email: ' User@Example.COM ', password: 'secret-value' })).toEqual({
      email: 'user@example.com',
      password: 'secret-value',
    });
    expect(() => SelectOrganizationRequestSchema.parse({
      selectionToken: 'opaque-token',
      organizationId: 'not-a-uuid',
    })).toThrow();
  });

  it('mantém o contrato público de instância independente do upstream', () => {
    const fieldNames = Object.keys(InstanceSchema.shape).join('|');

    expect(fieldNames).not.toMatch(/evolution|instanceName|apikey/i);
    expect(() => InstanceSchema.parse({
      id: 'not-a-uuid',
      organizationId: 'not-a-uuid',
      providerAccountId: 'not-a-uuid',
      name: 'Atendimento',
      provider: 'BAILEYS',
      status: 'CREATED',
      createdAt: '2026-09-03T12:00:00.000Z',
      updatedAt: '2026-09-03T12:00:00.000Z',
    })).toThrow();
  });

  it('centraliza os contratos públicos de mutação de instâncias', () => {
    expect(IdempotencyHeadersSchema.parse({ 'idempotency-key': 'create-1' }))
      .toMatchObject({ 'idempotency-key': 'create-1' });
    expect(ConnectInstanceRequestSchema.parse({ pairingHint: '5511999999999' }))
      .toEqual({ pairingHint: '5511999999999' });
    expect(() => InstanceIdParamsSchema.parse({ id: 'not-a-uuid' })).toThrow();
    expect(InstanceMutationResponseSchema.safeParse({}).success).toBe(false);
  });

  it('não expõe capabilities ainda não utilizadas no Incremento 1', () => {
    expect(() => InstanceSchema.parse({
      id: '2ba96098-4e50-4e19-88df-ee2099954f79',
      organizationId: '04211923-8057-4bf8-9d94-fb26cc67c57f',
      providerAccountId: '119498c0-ff0c-40aa-8bdd-1e581c42a884',
      name: 'Atendimento',
      provider: 'BAILEYS',
      status: 'CREATED',
      capabilities: ['upstream-specific-capability'],
      createdAt: '2026-09-03T12:00:00.000Z',
      updatedAt: '2026-09-03T12:00:00.000Z',
    })).toThrow();
  });

  it('padroniza respostas application/problem+json', () => {
    expect(PROBLEM_CONTENT_TYPE).toBe('application/problem+json');
    expect(ProblemDetailsSchema.parse({
      type: 'https://api.jrc.example/problems/invalid-request',
      title: 'Invalid request',
      status: 400,
      code: 'INVALID_REQUEST',
    })).toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
    expect(() => ProblemDetailsSchema.parse({ title: 'Invalid', status: 99, code: 'INVALID' })).toThrow();
  });
});
