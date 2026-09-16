import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { EmbedStartSchema, EmbedStartedSchema, EmbedExchangeSchema, EmbedExchangeResultSchema, EmbedApproveSchema,
  EmbedAppSchema, EmbedPolicySchema, EmbedApprovalViewSchema, ConnectionHealthSchema, ConnectionResponseSchema,
  ControlIdempotencyKeySchema, PROBLEM_CONTENT_TYPE } from '@jrc/contracts';
import { isConsoleOriginAllowed, parseBrowserCookieHeader, resolveBrowserCookiePolicy, verifyBrowserCsrfToken } from '@jrc/security';
import { authenticateRequest, type AuthenticationOptions } from '../plugins/authentication.js';
import type { EmbedAuthorizationService } from '../../modules/integrations/embed/authorization.js';
import { embedDenied } from '../../modules/integrations/embed/repository.js';
import type { ChatwootControlService } from '../../modules/integrations/chatwoot-control-service.js';
import { IntegrationError } from '../../modules/integrations/integration-error.js';
import { ChatwootError } from '../../modules/integrations/chatwoot-client.js';
import { InstanceServiceError } from '../../modules/instances/service.js';
import { resolveClientIp } from '../../modules/auth/rate-limit/keys.js';
import { tenantOperationalProblem } from '../../modules/tenancy/operational-limits.js';

export interface ChatwootEmbedRouteOptions extends AuthenticationOptions {
  nodeEnv: 'development' | 'test' | 'production'; service: EmbedAuthorizationService;
  facade?: ChatwootControlService | undefined; browserCsrfSecret: string; browserCookieSecure: boolean;
  consoleAllowedOrigins: readonly string[]; trustedProxyCidrs: readonly string[];
}
export async function registerChatwootEmbedRoutes(app: FastifyInstance, options: ChatwootEmbedRouteOptions) {
  app.decorateRequest('authentication', null);
  app.addHook('onRequest', async (_req, reply) => { reply.header('Cache-Control', 'no-store'); });
  app.setErrorHandler((error, req, reply) => {
    const operational = tenantOperationalProblem(error, req.id);
    const known = error instanceof IntegrationError || error instanceof InstanceServiceError;
    const validation = error instanceof z.ZodError || Boolean((error as { validation?: unknown }).validation);
    const status = operational?.status ?? (known ? error.status : validation ? 400 : error instanceof ChatwootError ? 502 : 503);
    const code = operational?.code ?? (known ? error.code : validation ? 'INVALID_REQUEST' : 'EMBED_UNAVAILABLE');
    return reply.code(status).type(PROBLEM_CONTENT_TYPE).send({ type: 'about:blank', status, title: code, code, requestId: req.id });
  });
  const feature = async () => options.service.repository.enabled();
  const authentication = authenticateRequest(options);
  const jwtOnly = async (req: FastifyRequest) => { if (req.authentication?.kind !== 'JWT') throw embedDenied(); };
  const cookiePolicy = resolveBrowserCookiePolicy({ nodeEnv: options.nodeEnv, secure: options.browserCookieSecure });
  const header = (req: FastifyRequest, name: string) => typeof req.headers[name] === 'string' ? req.headers[name] as string : undefined;
  const csrf = async (req: FastifyRequest) => {
    const cookies = parseBrowserCookieHeader(header(req, 'cookie'), cookiePolicy);
    if (!isConsoleOriginAllowed(header(req, 'origin'), options.consoleAllowedOrigins) ||
      !verifyBrowserCsrfToken(header(req, 'x-csrf-token'), cookies.csrfToken ?? undefined, options.browserCsrfSecret)) throw embedDenied();
  };
  const empty = z.strictObject({}), params = z.strictObject({ id: z.uuid() });
  const id = (req: FastifyRequest) => (req.params as { id: string }).id;
  const portal = [feature, authentication, jwtOnly];
  const ok = z.strictObject({ ok: z.literal(true) });
  const bearer = [{ bearerAuth: [] }];
  app.post('/v1/integrations/chatwoot/embed-apps', { preHandler: portal,
    schema: { querystring: empty, body: empty, response: { 201: EmbedAppSchema }, security: bearer } },
  async (req, reply) => reply.code(201).send(await options.service.apps.register(req.authentication!)));
  app.get('/v1/embed/apps/:id/policy', { preHandler: [feature],
    schema: { params, querystring: empty, response: { 200: EmbedPolicySchema }, security: [] } }, req => options.service.apps.policy(id(req)));
  app.post('/v1/embed/authorizations', { preHandler: [feature],
    schema: { querystring: empty, body: EmbedStartSchema, response: { 201: EmbedStartedSchema }, security: [] } }, async (req, reply) => {
    const input = EmbedStartSchema.parse(req.body);
    const ip = resolveClientIp({ remoteAddress: req.raw.socket.remoteAddress ?? req.ip, trustedProxyCidrs: options.trustedProxyCidrs,
      ...(req.headers['x-forwarded-for'] === undefined ? {} : { forwardedFor: req.headers['x-forwarded-for'] }) });
    return reply.code(201).send(await options.service.start(input.embedId, input.challenge, ip));
  });
  app.get('/v1/embed/authorizations/:id', { preHandler: portal,
    schema: { params, querystring: empty, response: { 200: EmbedApprovalViewSchema }, security: bearer } }, req => options.service.describe(req.authentication!, id(req)));
  app.post('/v1/embed/authorizations/:id/approve', { preHandler: [...portal, csrf],
    schema: { params, querystring: empty, body: EmbedApproveSchema, response: { 200: ok }, security: [{ bearerAuth: [], csrfHeaderAuth: [] }] } },
  req => options.service.approve(req.authentication!, id(req), EmbedApproveSchema.parse(req.body).integrationIds));
  app.post('/v1/embed/authorizations/:id/deny', { preHandler: [...portal, csrf],
    schema: { params, querystring: empty, body: empty, response: { 200: ok }, security: [{ bearerAuth: [], csrfHeaderAuth: [] }] } },
  req => options.service.deny(req.authentication!, id(req)));
  app.post('/v1/embed/authorizations/:id/exchange', { preHandler: [feature],
    schema: { params, querystring: empty, body: EmbedExchangeSchema, response: { 200: EmbedExchangeResultSchema }, security: [] } },
  req => options.service.exchange(id(req), EmbedExchangeSchema.parse(req.body).verifier));
  const token = (req: FastifyRequest) => {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header(req, 'authorization') ?? '');
    if (!match || req.headers['x-jrc-api-key'] !== undefined) throw embedDenied(); return match[1]!;
  };
  const facade = () => { if (!options.facade) throw new IntegrationError('EMBED_UNAVAILABLE', 503); return options.facade; };
  app.get('/v1/embed/connections/:id/status', { preHandler: [feature], schema: {
    params, querystring: empty, response: { 200: ConnectionHealthSchema }, security: [{ embedSessionAuth: [] }] } }, async req => {
    const raw = token(req), principal = await options.service.sessions.authorize(raw, id(req), 'chatwoot:read');
    const result = await facade().status(principal, id(req));
    await options.service.sessions.authorize(raw, id(req), 'chatwoot:read');
    return result;
  });
  app.post('/v1/embed/connections/:id/pair', { preHandler: [feature], schema: {
    params, querystring: empty, body: empty, headers: z.object({ 'idempotency-key': ControlIdempotencyKeySchema }).passthrough(),
    response: { 200: ConnectionResponseSchema, 202: ConnectionResponseSchema }, security: [{ embedSessionAuth: [] }] } }, async (req, reply) => {
    const raw = token(req), principal = await options.service.sessions.authorize(raw, id(req), 'chatwoot:pair');
    const result = await facade().pair(principal, id(req), String(req.headers['idempotency-key']));
    await options.service.sessions.authorize(raw, id(req), 'chatwoot:pair');
    return reply.code(result.pending && result.action.type === 'NONE' ? 202 : 200).send(result);
  });
}
