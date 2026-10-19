import {expect,it} from 'vitest';
import {HistoryImportSelectionSchema,HistoryImportCapabilitySchema,HistoryImportOperationSchema} from '../src/history-import.js';
const id='10000000-0000-4000-8000-000000000001',date='2026-01-01T00:00:00.000Z';
it('accepts the public selection and rejects unsafe limits and private fields',()=>{
 expect(HistoryImportSelectionSchema.parse({from:date,to:date,maxRecords:1000}).maxRecords).toBe(1000);
 expect(HistoryImportSelectionSchema.safeParse({from:date,to:date,maxRecords:Number.MAX_SAFE_INTEGER+1}).success).toBe(false);
 expect(HistoryImportSelectionSchema.safeParse({from:date,to:date,maxRecords:1,manifest:[]}).success).toBe(false);
});
it('keeps capability and operation responses strictly public',()=>{
 const capability={schemaVersion:1,organizationId:id,channelId:id,available:false,reason:'SOURCE_NOT_CONFIGURED',maxRecords:0};
 expect(HistoryImportCapabilitySchema.parse(capability)).toEqual(capability);
 expect(HistoryImportCapabilitySchema.safeParse({...capability,sourceFingerprint:'secret'}).success).toBe(false);
 const op={schemaVersion:1,id,organizationId:id,channelId:id,requestId:id,state:'OPEN',totalRecords:2,processedRecords:1,importedCount:1,duplicateCount:0,revision:1,from:date,to:date};
 expect(HistoryImportOperationSchema.parse(op)).toEqual(op);
 expect(HistoryImportOperationSchema.safeParse({...op,authority:{}}).success).toBe(false);
});
it('rejects reversed intervals and incoherent public state',()=>{
 expect(HistoryImportSelectionSchema.safeParse({from:'2026-02-01T00:00:00.000Z',to:date,maxRecords:1}).success).toBe(false);
 const capability={schemaVersion:1,organizationId:id,channelId:id,available:true,reason:null,maxRecords:1};
 expect(HistoryImportCapabilitySchema.safeParse({...capability,maxRecords:0}).success).toBe(false);
 expect(HistoryImportCapabilitySchema.safeParse({...capability,reason:'SOURCE_UNAVAILABLE'}).success).toBe(false);
 expect(HistoryImportCapabilitySchema.safeParse({...capability,available:false}).success).toBe(false);
 const op={schemaVersion:1,id,organizationId:id,channelId:id,requestId:id,state:'OPEN',totalRecords:2,processedRecords:1,importedCount:1,duplicateCount:0,revision:1,from:date,to:date};
 expect(HistoryImportOperationSchema.safeParse({...op,processedRecords:3}).success).toBe(false);
 expect(HistoryImportOperationSchema.safeParse({...op,duplicateCount:1}).success).toBe(false);
 expect(HistoryImportOperationSchema.safeParse({...op,state:'COMPLETED'}).success).toBe(false);
 expect(HistoryImportOperationSchema.safeParse({...op,totalRecords:1}).success).toBe(false);
});
