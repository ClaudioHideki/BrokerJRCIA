import {legacyStringsToNodeDiagnostics,type NodeDiagnostic} from '@jrc/contracts';

export class AutomationError extends Error{
 readonly details:NodeDiagnostic[];
 constructor(readonly code:string,readonly statusCode=422,details:readonly NodeDiagnostic[]|readonly string[]=[]){
  super(code);
  this.details=details.flatMap(item=>typeof item==='string'?legacyStringsToNodeDiagnostics([item]):[item]);
 }
}
