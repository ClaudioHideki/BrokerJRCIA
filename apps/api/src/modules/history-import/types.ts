import type {HistoryImportCapability,HistoryImportOperation,HistoryImportSelection} from '@jrc/contracts';
import type {HistoryScope,HistorySnapshot} from './contract.js';
import type {TenantTransaction} from '../../db/tenant-transaction.js';

export class HistoryImportError extends Error {
 constructor(readonly code:string,readonly statusCode:400|403|404|409|503=409){super(code);}
}
export interface HistorySourceScope extends HistoryScope {instanceId:string;instanceKey:string;ownerFingerprint?:string;providerFingerprint?:string;availableFrom?:string}
/** This private adapter is chosen by the server; browser input never supplies a manifest or engine address. */
export interface HistorySnapshotSource {
 /** Database-only binding check; must retain its revocation fence until commit. */
 bindingFingerprint?(tx:TenantTransaction,scope:HistorySourceScope):Promise<string>;
 capability(scope:HistorySourceScope):Promise<{available:boolean;maxRecords:number}>;
 createSnapshot(scope:HistorySourceScope,selection:HistoryImportSelection,requestId:string):Promise<unknown>;
 readPage(scope:HistorySourceScope,snapshot:HistorySnapshot,startOrdinal:number):Promise<unknown>;
}
export interface HistoryImportService {
 capability(org:string,actor:string,channel:string):Promise<HistoryImportCapability>;
 start(org:string,actor:string,channel:string,selection:HistoryImportSelection,requestId:string):Promise<HistoryImportOperation>;
 get(org:string,actor:string,channel:string,id:string):Promise<HistoryImportOperation>;
 byRequest(org:string,actor:string,channel:string,requestId:string):Promise<HistoryImportOperation>;
 advance(org:string,actor:string,channel:string,id:string):Promise<HistoryImportOperation>;
 cancel(org:string,actor:string,channel:string,id:string):Promise<HistoryImportOperation>;
}
