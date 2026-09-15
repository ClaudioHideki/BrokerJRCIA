import type { FastifyReply, FastifyRequest } from 'fastify';

import { PROBLEM_CONTENT_TYPE } from '@jrc/contracts';

export type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';
export type Permission =
  | 'instances:read'
  | 'instances:connect'
  | 'api_keys:manage'
  | 'memberships:manage'
  | 'memberships:change_owner';

export type AuthenticationContext =
  | Readonly<{
    kind: 'JWT';
    organizationId: string;
    actorId: string;
    role: Role;
  }>
  | Readonly<{
    kind: 'API_KEY';
    organizationId: string;
    actorId: null;
    apiKeyId: string;
    scopes: readonly string[];
  }>;

declare module 'fastify' {
  interface FastifyRequest {
    authentication: AuthenticationContext | null;
  }
}

const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  OWNER: new Set([
    'instances:read',
    'instances:connect',
    'api_keys:manage',
    'memberships:manage',
    'memberships:change_owner',
  ]),
  ADMIN: new Set([
    'instances:read',
    'instances:connect',
    'api_keys:manage',
    'memberships:manage',
  ]),
  OPERATOR: new Set(['instances:read', 'instances:connect']),
  VIEWER: new Set(['instances:read']),
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

function apiKeyAllows(scopes: readonly string[], permission: Permission): boolean {
  if (permission === 'instances:connect') return scopes.includes('instances:write');
  return scopes.includes(permission);
}

export function requirePermission(permission: Permission) {
  return async function permissionGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const context = request.authentication;
    const allowed = context?.kind === 'JWT'
      ? can(context.role, permission)
      : context?.kind === 'API_KEY'
        ? apiKeyAllows(context.scopes, permission)
        : false;
    if (allowed) return;

    await reply.code(403).type(PROBLEM_CONTENT_TYPE).send({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      code: 'FORBIDDEN',
      requestId: request.id,
    });
  };
}
