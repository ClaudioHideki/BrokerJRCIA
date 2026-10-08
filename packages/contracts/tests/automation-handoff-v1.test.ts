import { describe, expect, it } from 'vitest';
import { AutomationHandoffConfigV1Schema } from '../src/automation-handoff-v1.js';
import { getNodeDefinition } from '../src/automation-node-definitions.js';
import { validateAutomationGraph, AutomationGraphV1Schema } from '../src/automations-v1.js';

const config = { handoffVersion: 1, destination: {
  integrationId: '11111111-1111-4111-8111-111111111111', destinationRevision: 2,
  accountId: 4, inboxId: 8, credentialRevision: 3,
}, target: { teamId: 7, agentId: null } };
const graph = (data: Record<string, unknown>) => ({nodes: [
  {id:'start',type:'start',label:'Início',position:{x:0,y:0},data:{}},
  {id:'handoff',type:'handoff',label:'Transferir',position:{x:0,y:0},data},
],edges:[{id:'next',source:'start',target:'handoff',port:'next'}]});

describe('native handoff version 1', () => {
  it('accepts a revision-pinned team or agent target, never both', () => {
    expect(AutomationHandoffConfigV1Schema.parse(config)).toEqual(config);
    expect(AutomationHandoffConfigV1Schema.safeParse({...config,target:{teamId:null,agentId:9}}).success).toBe(true);
    for (const target of [{teamId:null,agentId:null},{teamId:7,agentId:9},{teamId:7},{teamId:0,agentId:null}])
      expect(AutomationHandoffConfigV1Schema.safeParse({...config,target}).success).toBe(false);
  });
  it('rejects forged authority, secret fields, invalid revisions and unsupported versions', () => {
    for (const invalid of [
      {...config,organizationId:'11111111-1111-4111-8111-111111111111'},
      {...config,destination:{...config.destination,organizationId:'11111111-1111-4111-8111-111111111111'}},
      {...config,destination:{...config.destination,credentialRevision:0}},
      {...config,destination:{...config.destination,destinationRevision:0}},
      {...config,destination:{...config.destination,inboxId:Number.MAX_SAFE_INTEGER+1}},
      {...config,target:{...config.target,token:'not-a-real-token'}},
      {...config,handoffVersion:2},
    ]) expect(AutomationHandoffConfigV1Schema.safeParse(invalid).success).toBe(false);
  });
  it('keeps historical graphs readable without making incomplete new handoffs valid', () => {
    expect(AutomationGraphV1Schema.safeParse(graph({})).success).toBe(true);
    expect(validateAutomationGraph(graph({}))).toEqual([]);
    expect(validateAutomationGraph(graph(config))).toEqual([]);
    expect(validateAutomationGraph(graph({handoffVersion:1}))).toContainEqual(expect.objectContaining({nodeId:'handoff',field:'data.destination',code:'INVALID_CONFIG'}));
    expect(validateAutomationGraph(graph({destination:config.destination}))).toContainEqual(expect.objectContaining({nodeId:'handoff',field:'data.handoffVersion',code:'INVALID_CONFIG'}));
  });
  it('keeps complete handoff and implemented time nodes creatable without exposing unfinished actions', () => {
    expect(getNodeDefinition('handoff',1)?.availability).toBe('AVAILABLE');
    for(const type of ['delay','schedule'])
      expect(getNodeDefinition(type,1)?.availability).toBe('AVAILABLE');
    for(const type of ['http','sql','code','ai-agent','subflow','media','tag','attribute','note','resolve'])
      expect(getNodeDefinition(type,1)?.availability).toBe('UNAVAILABLE');
  });
});
