import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ControlContextSchema, ControlIdempotencyKeySchema, IssueControlCredentialSchema, IssuedControlCredentialSchema, OperatorGrantsSchema, PROBLEM_CONTENT_TYPE } from '@jrc/contracts';
import { authenticateRequest, type AuthenticationOptions } from '../plugins/authentication.js';
import type { ChatwootControlAuth } from '../../modules/integrations/chatwoot-control-auth.js';
import { IntegrationError } from '../../modules/integrations/integration-error.js';
import { ChatwootError } from '../../modules/integrations/chatwoot-client.js';
import { tenantOperationalProblem } from '../../modules/tenancy/operational-limits.js';
import { IdempotencyConflictError } from '../../modules/instances/idempotency.js';

export interface ChatwootControlRouteOptions extends AuthenticationOptions { service: ChatwootControlAuth }
export async function registerChatwootControlRoutes(app: FastifyInstance, options: ChatwootControlRouteOptions) {
  app.decorateRequest('authentication', null);
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
  app.setErrorHandler((error, request, reply) => {
    const operational = tenantOperationalProblem(error, request.id);
    const known = error instanceof IntegrationError || error instanceof IdempotencyConflictError;
    const candidate = error as { validation?: unknown; code?: string };
    const status = operational?.status ?? (known ? error.status : candidate.validation || error instanceof z.ZodError ? 400 : candidate.code === '23505' ? 409 : error instanceof ChatwootError ? 502 : 503);
    const code = operational?.code ?? (known || error instanceof ChatwootError ? error.code : status === 400 ? 'INVALID_REQUEST' : status === 409 ? 'CONTROL_RESOURCE_CONFLICT' : 'CONTROL_UNAVAILABLE');
    return reply.code(status).type(PROBLEM_CONTENT_TYPE).send({ type: 'about:blank', status, title: code, code, requestId: request.id });
  });
  const authentication = authenticateRequest(options);
  const feature = async () => { if (!options.service.enabled) throw new IntegrationError('CHATWOOT_CONTROL_DISABLED', 404); };
  const portal = async (req: FastifyRequest, _reply: FastifyReply) => {
    if (req.authentication?.kind !== 'JWT') throw new IntegrationError('CHATWOOT_CONTROL_FORBIDDEN', 403);
  };
  const empty = z.strictObject({});
  const mutationHeaders = z.object({ 'idempotency-key': ControlIdempotencyKeySchema }).passthrough();
  const read = [authentication, feature], manage = [authentication, feature, portal];
  app.get('/v1/integrations/chatwoot/control/context', {
    preHandler: read, schema: { querystring: empty, response: { 200: ControlContextSchema } },
  }, req => options.service.context(req.authentication!));
  app.post('/v1/integrations/chatwoot/control-credentials', {
    preHandler: manage, schema: { querystring: empty, headers: mutationHeaders, body: IssueControlCredentialSchema, response: { 201: IssuedControlCredentialSchema } },
  }, async (req, reply) => reply.code(201).send(await options.service.issueCredential(req.authentication!, IssueControlCredentialSchema.parse(req.body), String(req.headers['idempotency-key']))));
  app.put('/v1/integrations/chatwoot/connections/:id/operator-grants', {
    preHandler: manage, schema: { querystring: empty, headers: mutationHeaders, params: z.strictObject({ id: z.uuid() }), body: OperatorGrantsSchema, response: { 200: z.strictObject({ ok: z.literal(true) }) } },
  }, req => options.service.setOperatorGrants(req.authentication!, (req.params as { id: string }).id, OperatorGrantsSchema.parse(req.body), String(req.headers['idempotency-key'])));
}
