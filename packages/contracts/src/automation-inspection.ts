import {z} from 'zod';
import {AutomationExecutionSummaryV1Schema} from './automations-v1.js';
export const AutomationExecutionQuerySchema=z.strictObject({
 automationId:z.uuid().optional(),status:AutomationExecutionSummaryV1Schema.shape.status.optional(),channelId:z.uuid().optional(),
 from:z.iso.datetime().optional(),to:z.iso.datetime().optional(),search:z.uuid().optional(),nodeId:z.string().min(1).max(100).optional(),
 cursor:z.string().min(1).max(2048).optional(),pageSize:z.coerce.number().int().min(1).max(100).optional(),
}).refine(query=>Object.keys(query).every(key=>key==='automationId')||Boolean(query.from&&query.to),{
 message:'Informe início e fim do período para consultar filtros, métricas ou páginas.',path:['from'],
});
export type AutomationExecutionQuery=z.input<typeof AutomationExecutionQuerySchema>;
export const AutomationExecutionMetricsSchema=z.strictObject({
 total:z.number().int().nonnegative(),completed:z.number().int().nonnegative(),active:z.number().int().nonnegative(),
 failed:z.number().int().nonnegative(),unknown:z.number().int().nonnegative(),canceled:z.number().int().nonnegative(),handoff:z.number().int().nonnegative(),
 completionRate:z.number().min(0).max(100).nullable(),
});
export const AutomationExecutionPageSchema=z.strictObject({
 data:z.array(AutomationExecutionSummaryV1Schema.extend({conversationRef:z.uuid().nullable(),durationMs:z.number().nonnegative(),errorCode:z.string().nullable()})),
 nextCursor:z.string().nullable(),metrics:AutomationExecutionMetricsSchema,
 period:z.strictObject({from:z.iso.datetime(),to:z.iso.datetime()}),
});
export type AutomationExecutionPage=z.infer<typeof AutomationExecutionPageSchema>;
export const AutomationExecutionPlaygroundSeedSchema=z.strictObject({
 executionId:z.uuid(),automationId:z.uuid(),version:z.number().int().positive(),text:z.string().max(4096),clock:z.iso.datetime(),
});
export type AutomationExecutionPlaygroundSeed=z.infer<typeof AutomationExecutionPlaygroundSeedSchema>;
