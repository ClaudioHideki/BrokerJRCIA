import { tenantOperationalProblem } from '../../modules/tenancy/operational-limits.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  ApiKeyIdParamsSchema,
  ApiKeyPageSchema,
  IssuedApiKeySchema,
  IssueApiKeyRequestSchema,
  ListApiKeysQuerySchema,
  PROBLEM_CONTENT_TYPE,
  ProblemDetailsSchema,
  type IssueApiKeyRequest,
  type IssuedApiKey,
  type ApiKey,
  type Page,
} from '@jrc/contracts';

import {
  authenticateRequest,
  type AuthenticatedApiKey,
} from '../plugins/authentication.js';
import { requirePermission } from '../plugins/authorization.js';
import { ApiKeyServiceError, type ApiKeyActorContext } from '../../modules/api-keys/service.js';

export interface ApiKeyRouteOptions {
  jwtSecret: string;
  authenticateApiKey(rawApiKey: string): Promise<AuthenticatedApiKey | null>;
  issueApiKey(
    context: ApiKeyActorContext,
    input: IssueApiKeyRequest,
  ): Promise<IssuedApiKey>;
  listApiKeys(
    context: ApiKeyActorContext,
    input: { limit: number; cursor?: string },
  ): Promise<Page<ApiKey>>;
  revokeApiKey(context: ApiKeyActorContext, id: string): Promise<boolean>;
}

function actorContext(request: FastifyRequest): ApiKeyActorContext {
  if (!request.authentication) throw new Error('Authentication context is unavailable');
  return request.authentication.kind === 'API_KEY'
    ? {
        credentialKind: 'API_KEY',
        organizationId: request.authentication.organizationId,
        actorId: null,
        apiKeyId: request.authentication.apiKeyId,
        requestId: request.id,
      }
    : {
        credentialKind: 'JWT',
        organizationId: request.authentication.organizationId,
        actorId: request.authentication.actorId,
        requestId: request.id,
      };
}

function problem(status: number, code: string, title: string, requestId: string) {
  return { type: 'about:blank', title, status, code, requestId };
}

function isUniqueNameConflict(error: unknown): boolean {
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate?.code === '23505' && candidate.constraint === 'api_keys_org_name_unique';
}

export async function registerApiKeyRoutes(
  app: FastifyInstance,
  options: ApiKeyRouteOptions,
): Promise<void> {
  app.decorateRequest('authentication', null);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Request-Id', request.id);
  });
  app.setErrorHandler((error, request, reply) => {
    const tenantProblem = tenantOperationalProblem(error, request.id);
    if (tenantProblem) return reply.code(tenantProblem.status).type(PROBLEM_CONTENT_TYPE).send(tenantProblem);
    const candidate = error as { validation?: unknown; statusCode?: unknown };
    if (error instanceof ApiKeyServiceError && error.code === 'CURSOR_NOT_FOUND') {
      return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(
        problem(404, 'NOT_FOUND', 'Resource not found', request.id),
      );
    }
    const clientStatus = candidate.validation !== undefined
      ? 400
      : typeof candidate.statusCode === 'number'
        && candidate.statusCode >= 400
        && candidate.statusCode < 500
        ? candidate.statusCode
        : error instanceof ApiKeyServiceError
          ? 400
          : null;
    if (clientStatus !== null) {
      return reply.code(clientStatus).type(PROBLEM_CONTENT_TYPE).send(
        problem(clientStatus, 'INVALID_REQUEST', 'Invalid request', request.id),
      );
    }
    if (isUniqueNameConflict(error)) {
      return reply.code(409).type(PROBLEM_CONTENT_TYPE).send(
        problem(409, 'API_KEY_NAME_CONFLICT', 'API key already exists', request.id),
      );
    }
    request.log.error({ err: error }, 'API key request failed');
    return reply.code(500).type(PROBLEM_CONTENT_TYPE).send(
      problem(500, 'INTERNAL_ERROR', 'Request failed', request.id),
    );
  });

  const typed = app.withTypeProvider<ZodTypeProvider>();
  const authentication = authenticateRequest({
    jwtSecret: options.jwtSecret,
    authenticateApiKey: options.authenticateApiKey,
  });
  const authorization = requirePermission('api_keys:manage');

  typed.post('/v1/api-keys', {
    preHandler: [authentication, authorization],
    schema: {
      body: IssueApiKeyRequestSchema,
      response: {
        201: IssuedApiKeySchema,
        400: ProblemDetailsSchema,
        401: ProblemDetailsSchema,
        403: ProblemDetailsSchema,
        409: ProblemDetailsSchema,
        415: ProblemDetailsSchema,
      },
    },
  }, async (request, reply) => {
    const created = await options.issueApiKey(actorContext(request), request.body);
    return reply.code(201).send(created);
  });

  typed.get('/v1/api-keys', {
    preHandler: [authentication, authorization],
    schema: {
      querystring: ListApiKeysQuerySchema,
      response: {
        200: ApiKeyPageSchema,
        400: ProblemDetailsSchema,
        401: ProblemDetailsSchema,
        403: ProblemDetailsSchema,
        404: ProblemDetailsSchema,
      },
    },
  }, async (request) => options.listApiKeys(actorContext(request), {
    limit: request.query.limit,
    ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
  }));

  typed.delete('/v1/api-keys/:id', {
    preHandler: [authentication, authorization],
    schema: {
      params: ApiKeyIdParamsSchema,
      response: {
        204: z.undefined(),
        400: ProblemDetailsSchema,
        401: ProblemDetailsSchema,
        403: ProblemDetailsSchema,
        404: ProblemDetailsSchema,
      },
    },
  }, async (request, reply) => {
    const revoked = await options.revokeApiKey(actorContext(request), request.params.id);
    if (!revoked) {
      return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(
        problem(404, 'NOT_FOUND', 'Resource not found', request.id),
      );
    }
    return reply.code(204).send(undefined);
  });
}
