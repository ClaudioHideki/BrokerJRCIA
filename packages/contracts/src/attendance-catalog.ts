import { z } from 'zod';
import { attendanceScopeSchema } from './attendance-v1.js';

const id=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const name=z.string().max(1000);
const capability=z.enum(['SUPPORTED','UNSUPPORTED','UNVERIFIED']);
export const attendanceCatalogSchema=z.strictObject({
  scope:attendanceScopeSchema,observedAt:z.iso.datetime(),credentialRevision:z.number().int().positive(),
  teams:z.array(z.strictObject({id,name,autoAssignment:z.boolean().nullable()})).max(10000),
  agents:z.array(z.strictObject({id,name,inboxMember:z.boolean()})).max(10000),
  labels:z.array(z.strictObject({id,name})).max(10000),
  attributes:z.array(z.strictObject({id,key:z.string().max(1000),name,displayType:z.string().max(100),model:z.string().max(100),values:z.array(z.string().max(1000)).max(1000)})).max(10000),
  hours:z.strictObject({enabled:z.boolean().nullable(),timezone:z.string().max(200).nullable(),days:z.array(z.strictObject({
    day:z.number().int().min(0).max(6),closed:z.boolean(),allDay:z.boolean(),
    openHour:z.number().int().min(0).max(23).nullable(),openMinute:z.number().int().min(0).max(59).nullable(),
    closeHour:z.number().int().min(0).max(23).nullable(),closeMinute:z.number().int().min(0).max(59).nullable(),
  })).max(7)}),
  remoteBot:z.strictObject({id,name}).nullable(),
  brokerBotId:id.nullable().optional(),
  inboxPolicy:z.strictObject({greetingEnabled:z.boolean().nullable(),autoAssignmentEnabled:z.boolean().nullable()}),
  capabilities:z.strictObject({teams:capability,agents:capability,inboxMembership:capability,labels:capability,attributes:capability,hours:capability,agentBot:capability,signatures:capability,controlEvents:capability,initialPending:capability}),
});
export type AttendanceCatalog=z.infer<typeof attendanceCatalogSchema>;
