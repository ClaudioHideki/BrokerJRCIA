import { expect,it,vi } from 'vitest';
import { createPostgresAutomationRepository } from '../../src/modules/automations/repository.js';
it.each(['CONFIRMED_SENT','CONFIRMED_NOT_SENT','UNRESOLVED'] as const)('cannot use generic manual %s to manufacture a native handoff outcome or replay a mutation',async outcome=>{
  const query=vi.fn(async()=>({rows:[{status:'UNKNOWN',kind:'HANDOFF'}],rowCount:1}));
  await expect(createPostgresAutomationRepository().reconcileUnknownOutbox({query} as never,{org:'tenant-a',executionId:'execution',outboxId:'handoff',actorId:'actor',outcome,evidenceCode:'MANUAL_CHECK'})).rejects.toMatchObject({code:'ATTENDANCE_HANDOFF_REMOTE_RECONCILIATION_REQUIRED'});
  expect(query).toHaveBeenCalledTimes(1);
});
