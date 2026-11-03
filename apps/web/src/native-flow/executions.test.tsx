// @vitest-environment jsdom
import {expect,it,vi} from 'vitest';
import {createNativeEditorTransport} from './transport.js';
const root='11111111-1111-4111-8111-111111111111',execution='22222222-2222-4222-8222-222222222222',handle='33333333-3333-4333-8333-333333333333';
const period='from=2030-01-01T00%3A00%3A00.000Z&to=2030-01-02T00%3A00%3A00.000Z';
it('maps bounded execution inspection to the pinned Account/session/root and rejects writes',async()=>{
 const request=vi.fn(async(_method:string,_path:string)=>({})),client=createNativeEditorTransport({accountId:3,handleId:handle,integrationIds:[root],rootAutomationId:root,request});
 await client.request(`/v1/automations/${root}/executions?${period}`);await client.request(`/v1/automations/${root}/executions/${execution}`);
 expect(request.mock.calls[0]?.slice(0,2)).toEqual(['get',`/api/v1/accounts/3/jrc_flow_delegation/sessions/${handle}/flows/${root}/executions?${period}`]);
 expect(request.mock.calls[1]?.[1]).toMatch(`/flows/${root}/executions/${execution}`);
 for(const path of [`/v1/automations/${execution}/executions?${period}`,`/v1/automations/${root}/executions?${period}&organizationId=${root}`,`/v1/automations/${root}/executions/${execution}/simulate`])await expect(client.request(path)).rejects.toThrow();
 await expect(client.request(`/v1/automations/${root}/executions/${execution}`,{method:'POST'})).rejects.toThrow();expect(request).toHaveBeenCalledTimes(2);
});
import {act,fireEvent,within} from '@testing-library/react';
import {AUTOMATION_NODE_CATALOG_V1,welcomeFlow} from '@jrc/contracts';
import {mountNativeFlowEditor} from './entry.js';
it('opens the real native execution tab and metadata detail without a Broker login or replay control',async()=>{
 const scope={capabilityVersion:1,organizationId:root,rootAutomationId:root,accountId:3,inboxIds:[7],revision:1};
 const data={schemaVersion:1,id:execution,organizationId:root,automationId:root,version:1,bindingId:root,channelId:root,status:'COMPLETED',currentNodeId:null,correlationId:execution,conversationRef:null,errorCode:null,startedAt:'2030-01-01T00:00:00.000Z',updatedAt:'2030-01-01T00:00:01.000Z',completedAt:'2030-01-01T00:00:01.000Z',durationMs:1000};
 const definition={schemaVersion:1,id:root,organizationId:root,name:'Nativo',lifecycleStatus:'PUBLISHED',draft:{revision:1,graph:welcomeFlow()},activeVersion:1,updatedAt:'2030-01-01T00:00:00.000Z'};
 const request=vi.fn(async(_method:string,path:string)=>{
  if(path.endsWith('/status'))return{enabled:true,canEdit:false,canPublish:false};if(path.endsWith('/nodes'))return{data:AUTOMATION_NODE_CATALOG_V1};
  if(path.endsWith('/executions/'+execution))return{scope,data,nodes:[],effects:[],truncated:false};
  if(path.includes('/executions?'))return{scope,data:[data],nextCursor:null,period:{from:'2030-01-01T00:00:00.000Z',to:'2030-01-02T00:00:00.000Z'},metrics:{total:1,completed:1,active:0,failed:0,unknown:0,canceled:0,handoff:0,completionRate:100}};
  if(path.endsWith('/'+root))return{...definition,scopeRevision:1};return{data:[definition],nextCursor:null};
 });
 const host=document.createElement('div');document.body.append(host);let close!:(()=>void);
 try{await act(async()=>{close=mountNativeFlowEditor(host,{accountId:3,handleId:handle,integrationIds:[root],context:{organizationId:root,accountId:3,actorId:9,scopes:['flow:read','flow:executions:read'],expiresAt:new Date(Date.now()+60000).toISOString()},request});});
  const ui=within(host.shadowRoot as unknown as HTMLElement);fireEvent.click(await ui.findByRole('link',{name:'Abrir editor'}));
  const validate=await ui.findByRole('button',{name:'Validar'});expect(validate).toBeDisabled();fireEvent.click(validate);
  expect(request.mock.calls.some(([,path])=>path.endsWith('/validate'))).toBe(false);
  fireEvent.click(await ui.findByRole('tab',{name:'Execuções'}));
  fireEvent.click(await ui.findByRole('link',{name:/v1/}));expect(await ui.findByText('Metadados da execução')).toBeVisible();expect(ui.queryByRole('button',{name:/Playground|Tentar novamente|Cancelar execução/})).toBeNull();
  expect(request.mock.calls.every(([method,path])=>method==='get'&&path.includes(`/accounts/3/jrc_flow_delegation/sessions/${handle}/flows`))).toBe(true);
 }finally{if(close)await act(async()=>close());host.remove();}
});
