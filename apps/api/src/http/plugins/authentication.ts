import type { FastifyReply, FastifyRequest } from 'fastify';

import { PROBLEM_CONTENT_TYPE } from '@jrc/contracts';
import { verifyAccessToken } from '@jrc/security';

import type { AuthenticationContext } from './authorization.js';
import type { Role } from './authorization.js';

declare module 'fastify' {
  interface FastifyInstance {
    resolveTenantRole?: (userId: string, organizationId: string) => Promise<Role | null>;
  }
}

export interface AuthenticatedApiKey {
  apiKeyId: string;
  organizationId: string;
  scopes: readonly string[];
}

export interface AuthenticationOptions {
  jwtSecret: string;
  authenticateApiKey(rawApiKey: string): Promise<AuthenticatedApiKey | null>;
}

function headerValue(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

export function authenticateRequest(options: AuthenticationOptions) {
  return async function authenticationGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    request.authentication = null;
    const authorization = headerValue(request.headers.authorization);
    const rawApiKey = headerValue(request.headers['x-jrc-api-key']);
    if ((authorization === null) === (rawApiKey === null)) {
      await rejectAuthentication(request, reply);
      return;
    }

    let context: AuthenticationContext | null = null;
    try {
      if (authorization !== null) {
        const match = /^Bearer ([^\s]+)$/.exec(authorization);
        if (match) {
          const payload = await verifyAccessToken(match[1]!, options.jwtSecret);
          const currentRole = request.server.resolveTenantRole
            ? await request.server.resolveTenantRole(payload.sub, payload.organization_id)
            : payload.role;
          if (!currentRole) { await rejectAuthentication(request, reply); return; }
          context = {
            kind: 'JWT',
            organizationId: payload.organization_id,
            actorId: payload.sub,
            role: currentRole,
          };
        }
      } else if (rawApiKey !== null) {
        const principal = await options.authenticateApiKey(rawApiKey);
        if (principal) {
          context = {
            kind: 'API_KEY',
            organizationId: principal.organizationId,
            actorId: null,
            apiKeyId: principal.apiKeyId,
            scopes: principal.scopes,
          };
        }
      }
    } catch {
      context = null;
    }

    if (!context) {
      await rejectAuthentication(request, reply);
      return;
    }
    request.authentication = context;
  };
}

async function rejectAuthentication(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await reply.code(401).type(PROBLEM_CONTENT_TYPE).send({
    type: 'about:blank',
    title: 'Authentication failed',
    status: 401,
    code: 'INVALID_CREDENTIALS',
    requestId: request.id,
  });
}
