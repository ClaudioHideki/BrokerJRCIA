import {it,expect} from 'vitest';
import {oiaBoxTemplateFlow,OIA_DEPARTMENTS,type AttendanceCatalog} from '@jrc/contracts';
import {executeAutomation} from '../../src/modules/automations/engine.js';
import {resolveBoxDirectory} from '../../src/modules/automations/box-directory.js';
import type {RuntimeState} from '../../src/modules/automations/types.js';
const org='11111111-1111-4111-8111-111111111111',channel='22222222-2222-4222-8222-222222222222';
const scope={organizationId:org,channelId:channel,integrationId:'33333333-3333-4333-8333-333333333333',destinationRevision:1,accountId:1,inboxId:20};
const teams=OIA_DEPARTMENTS.map((d,i)=>({id:i+1,name:d.pt,autoAssignment:false}));
const teamMembers=new Map(teams.map((t,i)=>[t.id,Array.from({length:OIA_DEPARTMENTS[i]!.positions},(_,p)=>({id:t.id*100+p+1,name:`Pessoa ${t.id} ${p+1}`}))]));
const catalog={scope,credentialRevision:1,teams,agents:[...teamMembers.values()].flat().map(a=>({...a,inboxMember:true})),capabilities:{teams:'SUPPORTED',agents:'SUPPORTED',inboxMembership:'SUPPORTED'}} as AttendanceCatalog;
const directory=resolveBoxDirectory({schemaVersion:1,routes:OIA_DEPARTMENTS.map((d,i)=>({routeKey:d.id,teamId:i+1,mode:'AGENT',membership:'ALL',agentIds:[]}))},catalog,teamMembers,1);
const root={automationId:'44444444-4444-4444-8444-444444444444',version:1,runtimeStateVersion:2 as const,graph:oiaBoxTemplateFlow()};
const now=new Date('2030-01-01T12:00:00Z');
const turn=(text:string,state?:RuntimeState)=>executeAutomation(root,{text,eventType:'MESSAGE',now,boxDirectory:directory,
 ...(state?.waiting?.waitId?{inputWait:{waitId:state.waiting.waitId,admittedAt:+now}}:{})},async()=>root,state);
for(const [languageIndex,language] of ['pt','en'].entries())for(const [departmentIndex,department] of OIA_DEPARTMENTS.entries())for(let option=1;option<=department.positions;option++){
 it(`routes ${language}/${department.id}/${option} to the offered authorized agent exactly once`,async()=>{
  const first=await turn('Oi'),lang=await turn(String(languageIndex+1),first.state),dept=await turn(String(departmentIndex+1),lang.state),result=await turn(String(option),dept.state);
  expect(dept.effects[0]?.payload.text).toContain(`${option} - Pessoa ${departmentIndex+1} ${option}`);
  expect(result.status).toBe('HANDOFF');expect(result.effects.filter(e=>e.kind==='HANDOFF')).toHaveLength(1);
  expect(result.effects.find(e=>e.kind==='HANDOFF')?.payload).toMatchObject({target:{teamId:null,agentId:(departmentIndex+1)*100+option},destination:{inboxId:20}});
 });
}
it('preserves return and invalid choices without replaying the greeting',async()=>{
 const first=await turn('Oi'),lang=await turn('1',first.state),dept=await turn('3',lang.state),back=await turn('5',dept.state),invalid=await turn('9',back.state);
 expect(back.effects).toHaveLength(1);expect(back.effects[0]?.payload.text).toContain('Selecione o departamento');
 expect(invalid.effects).toHaveLength(1);expect(invalid.effects[0]?.payload.text).toContain('Opção inválida');
 expect(invalid.effects.some(e=>e.kind==='HANDOFF')).toBe(false);expect(invalid.state.waiting?.invalidAttempts).toBe(1);
});
