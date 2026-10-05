import { describe,expect,it } from 'vitest';
import { attendanceDiagnostic } from '../../src/modules/attendance/diagnostics.js';
const good={gate:{allowed:true,revision:8,state:'READY' as const,cycle:1},scopeValid:true,ownerValid:true,localMode:'BOT',sessionState:'BOT_ACTIVE',pending:false};
describe('safe actionable attendance diagnostics',()=>{
  it('prioritizes scope/owner changes before offering resume',()=>{
    expect(attendanceDiagnostic({...good,scopeValid:false,ownerValid:false,gate:{...good.gate,allowed:false,state:'HUMAN'}}).reason).toBe('SCOPE_CHANGED');
    expect(attendanceDiagnostic({...good,ownerValid:false}).reason).toBe('OWNER_CHANGED');
  });
  it('explains a queued execution with no attempts as human control, not a failed send',()=>{
    expect(attendanceDiagnostic({...good,localMode:'HUMAN',gate:{...good.gate,allowed:false,state:'HUMAN'}}))
      .toEqual({allowed:false,reason:'HUMAN_CONTROL',controlRevision:8,cycle:1});
  });
  it('keeps pending reconciliation and paused sessions distinct from a ready bot',()=>{
    expect(attendanceDiagnostic({...good,pending:true,gate:{...good.gate,allowed:false}}).reason).toBe('REMOTE_RECONCILE');
    expect(attendanceDiagnostic({...good,sessionState:'ADMIN_PAUSED'}).reason).toBe('SESSION_PAUSED');
    expect(attendanceDiagnostic(good).reason).toBe('NONE');
  });
});
