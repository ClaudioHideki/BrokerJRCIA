import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { authenticateRequest, type AuthenticationOptions } from '../plugins/authentication.js';
import type { OrganizationTransaction } from '../../db/tenant-transaction.js';
import { readOperationalLimits } from '../../modules/tenancy/operational-limits.js';
import { BrokerOverviewSchema, BrokerPeriodSchema } from '@jrc/contracts';
import { readBrokerOverview } from '../../modules/broker/overview.js';
export interface TenantOperationsOptions extends AuthenticationOptions {
  transact<T>(organizationId: string, operation: OrganizationTransaction<T>): Promise<T>;
}
export async function registerTenantOperationsRoutes(
  app: FastifyInstance,
  options: TenantOperationsOptions,
) {
  app.decorateRequest('authentication', null);
  app.setErrorHandler((error, request, reply) => {
    const status = (error as { validation?: unknown }).validation ? 400 : 500;
    return reply
      .code(status)
      .send({
        status,
        code: status === 400 ? 'INVALID_REQUEST' : 'OPERATIONAL_DATA_UNAVAILABLE',
        requestId: request.id,
      });
  });
  app.withTypeProvider<ZodTypeProvider>().get(
    '/v1/organization/overview',
    {
      schema: {
        querystring: z.strictObject({ days: BrokerPeriodSchema.default('30') }),
        response: {
          200: BrokerOverviewSchema,
          403: z.object({ status: z.number(), code: z.string() }),
        },
      },
      preHandler: authenticateRequest(options),
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (request.authentication?.kind !== 'JWT')
        return reply.code(403).send({ status: 403, code: 'FORBIDDEN' });
      return options.transact(request.authentication.organizationId, (tx) =>
        readBrokerOverview(tx, request.authentication!.organizationId, Number(request.query.days)),
      );
    },
  );
  app
    .withTypeProvider<ZodTypeProvider>()
    .get(
      '/v1/organization/operations',
      { schema: { querystring: z.strictObject({}) }, preHandler: authenticateRequest(options) },
      async (request, reply) => {
        if (request.authentication?.kind !== 'JWT')
          return reply.code(403).send({ status: 403, code: 'FORBIDDEN' });
        const organizationId = request.authentication.organizationId;
        return options.transact(organizationId, (tx) => readOperationalLimits(tx, organizationId));
      },
    );
}
