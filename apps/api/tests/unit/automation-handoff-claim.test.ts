import {expect,it,vi} from 'vitest';
import {createPostgresAutomationRepository} from '../../src/modules/automations/repository.js';
import {runtimeAuthorityAllows} from '../../src/modules/attendance/runtime-authority.js';
vi.mock('../../src/modules/attendance/runtime-authority.js',()=>({runtimeAuthorityAllows:vi.fn(async()=>true)}));
it.each(['HANDOFF','SEND_TEXT'] as const)('claim %s preserves local authority and defers only handoff remote readiness to its durable coordinator',async kind=>{
  const query=vi.fn(async(sql:string)=>{
    if(sql.includes('select o.id,o.execution_id AS'))return {rows:[{id:'outbox',executionId:'execution',channelId:'channel',kind}],rowCount:1};
    if(sql.includes('from automation_executions where'))return {rows:[{id:'execution',organizationId:'tenant',channelId:'channel',conversationId:'conversation',automationId:'automation',version:1}],rowCount:1};
    if(sql.includes('returning id,organization_id'))return {rows:[{id:'outbox',kind}],rowCount:1};
    return {rows:[],rowCount:1};
  });
  await createPostgresAutomationRepository().claimOutbox({query} as never,'tenant','lease',120000,[kind]);
  expect(runtimeAuthorityAllows).toHaveBeenLastCalledWith(expect.anything(),expect.objectContaining({id:'execution'}),kind!=='HANDOFF');
});
