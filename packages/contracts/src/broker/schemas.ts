import { z } from 'zod';
const count = z.number().int().nonnegative();
export const BrokerPeriodSchema = z.enum(['7', '30', '90']);
export const BrokerDailySchema = z.object({
  date: z.iso.date(),
  incoming: count,
  outgoing: count,
  delivered: count,
  failed: count,
  unknown: count,
});
export const BrokerOverviewSchema = z.object({
  observedAt: z.iso.datetime(),
  periodDays: z.number().int(),
  periodStart: z.iso.datetime(),
  timezone: z.literal('UTC'),
  connections: z.object({
    total: count,
    online: count,
    attention: count,
    disconnected: count,
    provisioning: count,
    unobserved: count,
  }),
  providers: z.array(
    z.object({ provider: z.enum(['BAILEYS', 'META']), total: count, online: count }),
  ),
  messages: z.object({
    incoming: count,
    outgoing: count,
    delivered: count,
    failed: count,
    unknown: count,
  }),
  daily: z.array(BrokerDailySchema),
  incidents: z.array(
    z.object({
      id: z.uuid(),
      instanceId: z.uuid(),
      name: z.string(),
      status: z.string(),
      updatedAt: z.iso.datetime(),
    }),
  ),
  billing: z.null(),
});
export type BrokerOverview = z.infer<typeof BrokerOverviewSchema>;
