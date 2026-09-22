import type { AutomationGraphV1 } from '@jrc/contracts';

export type ExecutionStatus = 'QUEUED'|'RUNNING'|'WAITING'|'HANDOFF'|'COMPLETED'|'FAILED'|'CANCELED'|'UNKNOWN';
export interface RuntimeFrame { automationId:string; version:number; returnNodeId:string; deadlineAt?:number; outputSchema?:Record<string,unknown>;
  child?:{nodeId:string;automationId:string;version:number;correlationId:string;input:Record<string,unknown>} }
export interface RuntimeState {
  automationId:string; version:number; nodeId:string|null; variables:Record<string,string>; steps:number;
  stack:RuntimeFrame[]; waiting?:{kind:'EVENT'|'DELAY'|'IO';nodeId:string};
}
export interface RuntimeEffect { nodeId:string; ordinal:number; kind:'SEND_TEXT'|'HANDOFF'|'IO_HTTP'|'IO_SQL'|'IO_CODE'|'IO_AI'; payload:Record<string,unknown> }
export interface RuntimeTrace { nodeId:string; type:string; label:string; input:Record<string,unknown>; output:Record<string,unknown> }
export interface RuntimeResult {
  status:'WAITING'|'HANDOFF'|'COMPLETED'; state:RuntimeState; effects:RuntimeEffect[]; trace:RuntimeTrace[];
  wait?:{kind:'EVENT'|'DELAY'|'IO';nodeId:string;wakeAt?:Date};
}
export interface PublishedAutomation { automationId:string; version:number; graph:AutomationGraphV1 }
export interface RuntimeInput { text:string; eventType:'MESSAGE'|'RESUME'|'TIMER'; now:Date; payload?:Record<string,unknown> }

export interface AutomationSummary {
  schemaVersion:1; id:string; organizationId:string; name:string; lifecycleStatus:'DRAFT'|'PUBLISHED'|'ARCHIVED';
  draft:{revision:number;graph:AutomationGraphV1}; activeVersion:number|null; updatedAt:string;
}
