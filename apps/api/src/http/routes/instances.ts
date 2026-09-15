import { tenantOperationalProblem } from '../../modules/tenancy/operational-limits.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  CreateInstanceRequestSchema,
  ConnectInstanceRequestSchema,
  ConnectionResponseSchema,
  CursorPaginationQuerySchema,
  IdempotencyHeadersSchema,
  InstanceIdParamsSchema,
  InstanceMutationResponseSchema,
  InstancePageSchema,
  InstanceSchema,
  PROBLEM_CONTENT_TYPE,
  ProblemDetailsSchema,
} from '@jrc/contracts';

import {
  InstanceServiceError,
  type InstanceActorContext,
  type InstanceService,
} from '../../modules/instances/service.js';
import {
  authenticateRequest,
  type AuthenticatedApiKey,
} from '../plugins/authentication.js';
import { requirePermission } from '../plugins/authorization.js';
import { registerRequestContext } from '../plugins/request-context.js';

const EmptyBodySchema = z.object({}).strict();

export interface InstanceRouteOptions {
  jwtSecret: string;
  authenticateApiKey(rawApiKey: string): Promise<AuthenticatedApiKey | null>;
  service: InstanceService;
  now?: () => Date;
  requestTimeoutMs?: number;
}

function actorContext(request: FastifyRequest): InstanceActorContext {
  const authentication = request.authentication;
  if (!authentication) throw new Error('Authentication context is unavailable');
  return authentication.kind === 'API_KEY'
    ? {
        credentialKind: 'API_KEY',
        organizationId: authentication.organizationId,
        actorId: null,
        apiKeyId: authentication.apiKeyId,
        requestId: request.id,
        deadline: request.operationDeadline,
        signal: request.operationSignal,
      }
    : {
        credentialKind: 'JWT',
        organizationId: authentication.organizationId,
        actorId: authentication.actorId,
        requestId: request.id,
        deadline: request.operationDeadline,
        signal: request.operationSignal,
      };
}

function problem(status: number, code: string, title: string, requestId: string) {
  return { type: 'about:blank', title, status, code, requestId };
}

function serviceProblem(error: InstanceServiceError, requestId: string) {
  const notFound = error.status === 404;
  const conflict = error.status === 409;
  return problem(
    error.status,
    notFound ? 'NOT_FOUND' : error.code,
    notFound ? 'Resource not found' : conflict ? 'Request conflict' : 'Invalid request',
    requestId,
  );
}

export async function registerInstanceRoutes(
  app: FastifyInstance,
  options: InstanceRouteOptions,
): Promise<void> {
  app.decorateRequest('authentication', null);
  await registerRequestContext(app, {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.requestTimeoutMs === undefined ? {} : { timeoutMs: options.requestTimeoutMs }),
  });
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, request, reply) => {
    const tenantProblem = tenantOperationalProblem(error, request.id);
    if (tenantProblem) return reply.code(tenantProblem.status).type(PROBLEM_CONTENT_TYPE).send(tenantProblem);
    if (error instanceof InstanceServiceError) {
      const body = serviceProblem(error, request.id);
      return reply.code(error.status).type(PROBLEM_CONTENT_TYPE).send(body);
    }
    const candidate = error as { validation?: unknown; statusCode?: unknown };
    const status = candidate.validation !== undefined
      ? 400
      : typeof candidate.statusCode === 'number'
        && candidate.statusCode >= 400
        && candidate.statusCode < 500
        ? candidate.statusCode
        : null;
    if (status !== null) {
      return reply.code(status).type(PROBLEM_CONTENT_TYPE).send(
        problem(status, 'INVALID_REQUEST', 'Invalid request', request.id),
      );
    }
    request.log.error({ err: error }, 'Instance request failed');
    return reply.code(500).type(PROBLEM_CONTENT_TYPE).send(
      problem(500, 'INTERNAL_ERROR', 'Request failed', request.id),
    );
  });

  const typed = app.withTypeProvider<ZodTypeProvider>();
  const authentication = authenticateRequest({
    jwtSecret: options.jwtSecret,
    authenticateApiKey: options.authenticateApiKey,
  });
  const read = requirePermission('instances:read');
  const mutate = requirePermission('instances:connect');

  typed.post('/v1/instances', {
    preHandler: [authentication, mutate],
    schema: {
      headers: IdempotencyHeadersSchema,
      body: CreateInstanceRequestSchema,
      response: {
        200: InstanceMutationResponseSchema,
        201: InstanceMutationResponseSchema,
        202: InstanceMutationResponseSchema,
        400: ProblemDetailsSchema,
        401: ProblemDetailsSchema,
        403: ProblemDetailsSchema,
        404: ProblemDetailsSchema,
        409: ProblemDetailsSchema,
        415: ProblemDetailsSchema,
        502: ProblemDetailsSchema,
      },
    },
  }, async (request, reply) => {
    const result = await options.service.createInstance(actorContext(request), {
      ...request.body,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return reply.code(result.pending ? 202 : result.replayed ? 200 : 201).send(result);
  });

  typed.get('/v1/instances', {
    preHandler: [authentication, read],
    schema: {
      querystring: CursorPaginationQuerySchema,
      response: {
        200: InstancePageSchema,
        400: ProblemDetailsSchema,
        401: ProblemDetailsSchema,
        403: ProblemDetailsSchema,
        404: ProblemDetailsSchema,
      },
    },
  }, async (request) => options.service.listInstances(actorContext(request), {
    limit: request.query.limit,
    ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
  }));

  typed.get('/v1/instances/:id', {
    preHandler: [authentication, read],
    schema: {
      params: InstanceIdParamsSchema,
      response: {
        200: InstanceSchema,
        400: ProblemDetailsSchema,
        401: ProblemDetailsSchema,
        403: ProblemDetailsSchema,
        404: ProblemDetailsSchema,
      },
    },
  }, async (request) => options.service.getInstance(actorContext(request), request.params.id));

  typed.post('/v1/instances/:id/connect', {
    preHandler: [authentication, mutate],
    schema: {
      params: InstanceIdParamsSchema,
      headers: IdempotencyHeadersSchema,
      body: ConnectInstanceRequestSchema,
      response: {
        200: ConnectionResponseSchema,
        202: ConnectionResponseSchema,
        400: ProblemDetailsSchema,
        401: ProblemDetailsSchema,
        403: ProblemDetailsSchema,
        404: ProblemDetailsSchema,
        409: ProblemDetailsSchema,
        415: ProblemDetailsSchema,
        502: ProblemDetailsSchema,
      },
    },
  }, async (request, reply) => {
    reply.header('Pragma', 'no-cache');
    const result = await options.service.connectInstance(actorContext(request), {
      instanceId: request.params.id,
      idempotencyKey: request.headers['idempotency-key'],
      ...(request.body.pairingHint === undefined ? {} : { pairingHint: request.body.pairingHint }),
    });
    const connectionPending = result.pending
      && result.action.type === 'NONE'
      && result.action.reason === 'CONNECTION_PENDING';
    return reply.code(connectionPending ? 202 : 200).send(result);
  });

  typed.get('/v1/instances/:id/status', {
    preHandler: [authentication, read],
    schema: {
      params: InstanceIdParamsSchema,
      response: {
        200: InstanceSchema,
        400: ProblemDetailsSchema,
        401: ProblemDetailsSchema,
        403: ProblemDetailsSchema,
        404: ProblemDetailsSchema,
        502: ProblemDetailsSchema,
      },
    },
  }, async (request) => options.service.getInstanceStatus(actorContext(request), request.params.id));

  typed.post('/v1/instances/:id/disconnect', {
    preHandler: [authentication, mutate],
    schema: {
      params: InstanceIdParamsSchema,
      headers: IdempotencyHeadersSchema,
      body: EmptyBodySchema,
      response: {
        200: InstanceMutationResponseSchema,
        202: InstanceMutationResponseSchema,
        400: ProblemDetailsSchema,
        401: ProblemDetailsSchema,
        403: ProblemDetailsSchema,
        404: ProblemDetailsSchema,
        409: ProblemDetailsSchema,
        415: ProblemDetailsSchema,
        502: ProblemDetailsSchema,
      },
    },
  }, async (request, reply) => {
    const result = await options.service.disconnectInstance(actorContext(request), {
      instanceId: request.params.id,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return reply.code(result.pending ? 202 : 200).send(result);
  });
}
