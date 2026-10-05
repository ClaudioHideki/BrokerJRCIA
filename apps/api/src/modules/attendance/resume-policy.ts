import type { AutomationGraphV1, ResumeTarget } from '@jrc/contracts';
import type { RuntimeState } from '../automations/types.js';
import { assertRuntimeState } from '../automations/runtime-state.js';
import { AttendanceError } from './types.js';
export function validateResumeTarget(input: {
  target: ResumeTarget; hasActiveSession: boolean; hasCompatibleCursor: boolean;
  hasPublishedAutomation: boolean; hasMenuNode: boolean;
}): void {
  if (!input.hasPublishedAutomation) throw new AttendanceError('AUTOMATION_NOT_PUBLISHED', 409);
  if (input.target.kind === 'CONTINUE' && (!input.hasActiveSession || !input.hasCompatibleCursor))
    throw new AttendanceError('ATTENDANCE_RESUME_CURSOR_UNAVAILABLE', 409);
  if (input.target.kind === 'MENU') {
    if (!input.hasActiveSession) throw new AttendanceError('ATTENDANCE_RESUME_NEW_SESSION_REQUIRED', 409);
    if (!input.hasMenuNode) throw new AttendanceError('ATTENDANCE_RESUME_MENU_UNAVAILABLE', 409);
  }
}

/** A menu jump preserves variables only from a valid root cursor in the pinned version. */
export function isResumeRootState(state:RuntimeState|null|undefined,automationId:string|null,version:number|null,graph:AutomationGraphV1|null,runtimeVersion=1):state is RuntimeState {
  if(!state||!graph||state.automationId!==automationId||state.version!==version||(state.runtimeStateVersion??1)!==runtimeVersion||
    !Array.isArray(state.stack)||state.stack.length||!state.variables||typeof state.variables!=='object'||Array.isArray(state.variables)||
    !Number.isSafeInteger(state.steps)||state.steps<0||state.steps>=5000||state.nodeId!==null&&!graph.nodes.some(n=>n.id===state.nodeId))return false;
  try{assertRuntimeState(state);return true;}catch{return false;}
}
