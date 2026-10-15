import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { NicoExternalActorSchema, NicoTakeoverSnapshotSchema, NicoTakeoverRequestSchema, NicoTakeoverOperationSchema,
  NicoTakeoverCancelSchema, NicoTakeoverCompleteSchema } from '@jrc/contracts';
import type { ChatwootControlAuth } from '../../modules/integrations/chatwoot-control-auth.js';
import type { NicoTakeovers } from '../../modules/integrations/nico-takeover-types.js';
import { IntegrationError } from '../../modules/integrations/integration-error.js';

export function registerNicoTakeoverRoutes(app: FastifyInstance, auth: ChatwootControlAuth, service: NicoTakeovers | undefined,
  preHandler: preHandlerHookHandler[]) {
  const empty = z.strictObject({});
  const remoteId = z.string().regex(/^[1-9][0-9]{0,15}$/).refine(value => Number.isSafeInteger(Number(value)));
  const params = z.strictObject({ integrationId: z.uuid(), remoteConversationId: remoteId });
  const operationParams = params.extend({ takeoverId: z.uuid() });
  const headers = z.object({ 'x-jrc-external-actor': NicoExternalActorSchema }).passthrough();
  const api = () => { if (!service) throw new IntegrationError('NICO_TAKEOVER_NOT_CONFIGURED', 503); return service; };
  const scope = (req: FastifyRequest) => { const p = req.params as { integrationId: string; remoteConversationId: string }; return { integration: p.integrationId, remote: Number(p.remoteConversationId) }; };
  const principal = async (req: FastifyRequest) => {
    if (req.authentication?.kind !== 'API_KEY') throw new IntegrationError('CHATWOOT_CONTROL_FORBIDDEN', 403);
    return auth.authorize(req.authentication, 'chatwoot:manage', scope(req).integration,
      NicoExternalActorSchema.parse(req.headers['x-jrc-external-actor']));
  };
  app.get('/v1/integrations/chatwoot/control/connections/:integrationId/conversations/:remoteConversationId/attendance', { preHandler, schema: { params, querystring: empty, headers, response: { 200: NicoTakeoverSnapshotSchema } } },
    async req => api().attendance(await principal(req), scope(req).integration, scope(req).remote));
  app.post('/v1/integrations/chatwoot/control/connections/:integrationId/conversations/:remoteConversationId/takeovers', { preHandler, schema: { params, querystring: empty, headers: headers.extend({ 'idempotency-key': z.uuid() }),
    body: NicoTakeoverRequestSchema, response: { 200: NicoTakeoverOperationSchema } } }, async req => {
    const input = NicoTakeoverRequestSchema.parse(req.body);
    if (input.requestId !== req.headers['idempotency-key']) throw new IntegrationError('NICO_TAKEOVER_KEY_MISMATCH', 400);
    return api().start(await principal(req), scope(req).integration, scope(req).remote, input);
  });
  app.post('/v1/integrations/chatwoot/control/connections/:integrationId/conversations/:remoteConversationId/takeovers/cancel', { preHandler, schema: { params, querystring: empty, headers,
    body: NicoTakeoverCancelSchema, response: { 200: NicoTakeoverOperationSchema } } },
  async req => api().cancel(await principal(req), scope(req).integration, scope(req).remote, NicoTakeoverCancelSchema.parse(req.body)));
  app.get('/v1/integrations/chatwoot/control/connections/:integrationId/conversations/:remoteConversationId/takeovers/:takeoverId', { preHandler, schema: { params: operationParams, querystring: empty, headers,
    response: { 200: NicoTakeoverOperationSchema } } },
  async req => api().get(await principal(req), scope(req).integration, scope(req).remote, operationParams.parse(req.params).takeoverId));
  app.post('/v1/integrations/chatwoot/control/connections/:integrationId/conversations/:remoteConversationId/takeovers/:takeoverId/complete', { preHandler, schema: { params: operationParams, querystring: empty, headers,
    body: NicoTakeoverCompleteSchema, response: { 200: NicoTakeoverOperationSchema } } },
  async req => api().complete(await principal(req), scope(req).integration, scope(req).remote,
    operationParams.parse(req.params).takeoverId, NicoTakeoverCompleteSchema.parse(req.body).messageId));
}
