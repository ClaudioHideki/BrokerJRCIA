import { expect, it } from 'vitest';
import { convertAutomationArtifact } from '../../src/modules/automation-integrations/importer.js';
import { executeAutomation, validateAutomationGraph } from '../../src/modules/automations/engine.js';
const node = (id:string,type:string,data:Record<string,unknown>={}) => ({id,type,label:id,position:{x:40,y:80},data});
const edge = (source:string,target:string,port='next') => ({id:`${source}-${port}`,source,target,port});
const artifact = (nodes:unknown[],edges:unknown[],settings:Record<string,unknown>={}) => JSON.stringify({format:'jrc-flows/1',flow:{name:'Fluxo local',kind:'chatbot',engine:'native',settings:{trigger:'message_created',inbox_ids:[999],...settings},graph:{nodes,edges}}});
it('converts local switch rules in order and preserves normalized comparisons', async () => {
  const converted=convertAutomationArtifact('AUTO',artifact([
    node('s','start'),node('choice','switch',{cases:[{id:'one',label:'Primeiro',operator:'equals',value:'Sim'}, {id:'two',label:'Segundo',operator:'contains',value:'im'}]}),
    node('a','message',{text:'primeiro'}),node('b','message',{text:'segundo'}),node('end','end'),
  ],[edge('s','choice'),edge('choice','a','one'),edge('choice','b','two'),edge('choice','end','fallback'),edge('a','end'),edge('b','end')]));
  expect(converted.graph.nodes.find(n=>n.id==='choice')?.type).toBe('condition');
  // The original inbox/trigger policy must be reviewed before publication.
  expect(converted.report.summary.manualReviewRequired).toBe(true);
  expect(converted.report.warnings.join(' ')).toMatch(/caixas/i);
  const graph={...converted.graph,nodes:converted.graph.nodes.filter(n=>n.data.sourceType!=='IMPORT_REVIEW_REQUIRED')};
  expect(validateAutomationGraph(graph)).toEqual([]);
  const result=await executeAutomation({automationId:'a',version:1,graph}, {text:' SIM ',now:new Date(),eventType:'MESSAGE'},async()=>{throw new Error('no subflow');});
  expect(result.effects.map(effect=>effect.payload.text)).toEqual(['primeiro']);
});
it('does not claim exact conversion for CRM, input timeout, human destination or timer policy', () => {
  const converted=convertAutomationArtifact('JRC',artifact([
    node('s','start'),node('capture','input',{variable:'name',timeout:30}),node('crm','create_lead',{api_key:'must-not-copy'}),node('human','assign',{team_id:99}),
  ],[edge('s','capture'),edge('capture','crm'),edge('capture','human','timeout'),edge('crm','human')]));
  expect(converted.report.nodes.filter(n=>['capture','crm','human'].includes(n.sourceId)).every(n=>n.classification==='UNSUPPORTED')).toBe(true);
  expect(validateAutomationGraph(converted.graph).length).toBeGreaterThan(0);
  expect(JSON.stringify(converted)).not.toContain('must-not-copy');
  expect(JSON.stringify(converted.graph)).not.toContain('team_id');
});
it('does not reclassify the Broker native format and rejects excessive conversion growth', () => {
  const native=JSON.stringify({format:'jrc-broker-flows/1',flow:{name:'Broker',graph:{nodes:[node('s','start'),node('end','end')],edges:[edge('s','end')]}}});
  expect(convertAutomationArtifact('AUTO',native).report.summary.manualReviewRequired).toBe(false);
  const nodes=[node('s','start'),...Array.from({length:149},(_,i)=>node(`n${i}`,'message',{text:'Oi'}))];
  expect(()=>convertAutomationArtifact('AUTO',artifact(nodes,[]))).toThrow(/150|limite|blocos/i);
});
