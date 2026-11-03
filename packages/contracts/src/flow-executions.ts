import {z} from 'zod';
import {AutomationExecutionQuerySchema,AutomationExecutionPageSchema} from './automation-inspection.js';
const {automationId:_,...filters}=AutomationExecutionQuerySchema.shape;
export const FlowExecutionQuerySchema=z.strictObject({...filters,from:z.iso.datetime(),to:z.iso.datetime()});
export const FlowExecutionScopeSchema=z.strictObject({capabilityVersion:z.literal(1),organizationId:z.uuid(),rootAutomationId:z.uuid(),accountId:z.number().int().positive(),inboxIds:z.array(z.number().int().positive()).min(1).max(100),revision:z.number().int().positive()});
export const FlowExecutionPageSchema=AutomationExecutionPageSchema.extend({scope:FlowExecutionScopeSchema});
export const FlowExecutionDetailSchema=z.strictObject({scope:FlowExecutionScopeSchema,
 data:AutomationExecutionPageSchema.shape.data.element,
 nodes:z.array(z.strictObject({id:z.uuid(),nodeId:z.string(),status:z.string(),attempt:z.number().int().positive(),durationMs:z.number().nonnegative().nullable(),errorCode:z.string().nullable()})).max(200),
 effects:z.array(z.strictObject({id:z.uuid(),nodeId:z.string(),kind:z.string(),status:z.string(),attempts:z.number().int().nonnegative()})).max(200),
 truncated:z.boolean(),
});
export type FlowExecutionDetail=z.infer<typeof FlowExecutionDetailSchema>;
