import { describe, expect, it } from 'vitest';

import {
  ConsoleSessionResponseSchema,
  LoginOrganizationsSchema,
} from '../src/index.js';
import * as contracts from '../src/index.js';

const ORGANIZATION_ID = '92776cb0-bcba-45c0-98a3-2937fefdfdaf';

describe('contratos da sessão da console', () => {
  it('tipa a rejeição genérica de troca sem revelar o motivo ou tenant', () => {
    const schema = (contracts as Record<string, unknown>)[
      'ConsoleOrganizationSwitchRejectedProblemSchema'
    ] as { safeParse(value: unknown): { success: boolean } } | undefined;
    expect(schema).toBeDefined();
    if (!schema) return;

    const problem = {
      type: 'about:blank',
      title: 'Organization switch failed',
      status: 409,
      code: 'ORGANIZATION_SWITCH_REJECTED',
      requestId: '0e213691-faec-4abe-a3b6-439a6bedc80d',
    };
    expect(schema.safeParse(problem).success).toBe(true);
    expect(schema.safeParse({ ...problem, code: 'OTHER_CONFLICT' }).success).toBe(false);
    expect(schema.safeParse({ ...problem, status: 401 }).success).toBe(false);
    expect(schema.safeParse({ ...problem, organizationId: ORGANIZATION_ID }).success).toBe(false);
  });

  it('inclui o papel em todas as organizações retornadas pelo login público', () => {
    const parsed = LoginOrganizationsSchema.parse({
      organizations: [{
        id: ORGANIZATION_ID,
        name: 'JRC',
        slug: 'jrc',
        role: 'OWNER',
      }],
      selectionToken: 'A'.repeat(43),
      expiresAt: '2030-01-01T12:05:00.000Z',
    });

    expect(parsed.organizations[0]?.role).toBe('OWNER');
    expect(LoginOrganizationsSchema.safeParse({
      ...parsed,
      organizations: [{ id: ORGANIZATION_ID, name: 'JRC', slug: 'jrc' }],
    }).success).toBe(false);
  });

  it('retorna somente token de acesso e organizações com papel no corpo da console', () => {
    const response = {
      accessToken: 'access-token-value',
      tokenType: 'Bearer',
      expiresIn: 600,
      user: {
        id: '8e757fb4-18ff-4c20-841b-19f282ece546',
        email: 'owner@example.test',
      },
      activeOrganization: {
        id: ORGANIZATION_ID,
        name: 'JRC',
        slug: 'jrc',
        role: 'ADMIN',
      },
      organizations: [{
        id: ORGANIZATION_ID,
        name: 'JRC',
        slug: 'jrc',
        role: 'ADMIN',
      }],
    };

    expect(ConsoleSessionResponseSchema.parse(response)).toEqual(response);
    expect(ConsoleSessionResponseSchema.safeParse({
      ...response,
      refreshToken: 'must-never-reach-browser-javascript',
    }).success).toBe(false);
    expect(ConsoleSessionResponseSchema.safeParse({
      ...response,
      user: {
        ...response.user,
        password: 'must-never-reach-browser-javascript',
        passwordHash: 'must-never-reach-browser-javascript',
      },
    }).success).toBe(false);
  });
});
