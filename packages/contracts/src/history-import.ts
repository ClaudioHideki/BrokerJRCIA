import {z} from 'zod';
const count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const uuid=z.string().uuid(), instant=z.string().datetime();
export const HistoryImportSelectionSchema=z.object({from:instant,to:instant,maxRecords:count.positive()}).strict().refine(value=>Date.parse(value.from)<=Date.parse(value.to),{message:'Intervalo inválido'});
export const HistoryImportCapabilitySchema=z.object({schemaVersion:z.literal(1),organizationId:uuid,channelId:uuid,available:z.boolean(),reason:z.enum(['SOURCE_NOT_CONFIGURED','CHANNEL_UNAVAILABLE','IDENTITY_NOT_VERIFIED','SOURCE_UNAVAILABLE']).nullable(),maxRecords:count,availableFrom:instant.optional()}).strict().refine(value=>value.available?value.reason===null&&value.maxRecords>0:value.reason!==null,{message:'Capacidade incoerente'});
export const HistoryImportOperationSchema=z.object({schemaVersion:z.literal(1),id:uuid,organizationId:uuid,channelId:uuid,requestId:uuid,state:z.enum(['OPEN','COMPLETED','CANCELED']),totalRecords:count,processedRecords:count,importedCount:count,duplicateCount:count,revision:count.positive(),from:instant,to:instant,lastError:z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).nullable().optional()}).strict().refine(value=>Date.parse(value.from)<=Date.parse(value.to)&&value.processedRecords<=value.totalRecords&&value.importedCount+value.duplicateCount===value.processedRecords&&(value.state==='COMPLETED'?value.processedRecords===value.totalRecords:value.processedRecords<value.totalRecords),{message:'Progresso incoerente'});
export type HistoryImportSelection=z.infer<typeof HistoryImportSelectionSchema>;
export type HistoryImportCapability=z.infer<typeof HistoryImportCapabilitySchema>;
export type HistoryImportOperation=z.infer<typeof HistoryImportOperationSchema>;
