import {describe,expect,it} from 'vitest';
import {convertAutomationArtifact} from '../../src/modules/automation-integrations/importer.js';
import {validateAutomationGraph} from '../../src/modules/automations/engine.js';
import { welcomeFlow } from '@jrc/contracts';
describe('automation imports',()=>{
 it('detects a native JRC file without requiring an engine selection',()=>{
  const result=convertAutomationArtifact('AUTO',JSON.stringify({format:'jrc-flows/1',flow:{name:'Atendimento',graph:welcomeFlow()}}));
  expect(result.source).toBe('JRC');expect(result.report.summary).toMatchObject({total:3,exact:3,unsupported:0});
 });
 it('detects an external grouped conversation export automatically',()=>{
  const result=convertAutomationArtifact('AUTO',JSON.stringify({name:'Atendimento',groups:[{blocks:[{id:'hello',type:'text',content:{text:'Olá'}}]}]}));
  expect(result.graph.nodes.some(node=>node.type==='message')).toBe(true);
 });
 it('classifies n8n incompatibilities and strips credential material',()=>{const source={name:'Atendimento',nodes:[{id:'start',name:'Webhook',type:'n8n-nodes-base.webhook',position:[0,0],parameters:{},credentials:{httpHeaderAuth:{id:'secret-id'}}},{id:'custom',name:'Código externo',type:'n8n-nodes-base.code',position:[200,0],parameters:{jsCode:'return $input.all()'}}],connections:{Webhook:{main:[[{node:'Código externo',type:'main',index:0}]]}}},result=convertAutomationArtifact('N8N',JSON.stringify(source));expect(result.report.summary).toMatchObject({partial:1,unsupported:1,credentialsRemoved:true,autoPublished:false,manualReviewRequired:true});expect(JSON.stringify(result.graph)).not.toContain('secret-id');});
 it('converts safe Typebot blocks but reports semantic loss',()=>{const result=convertAutomationArtifact('TYPEBOT',JSON.stringify({name:'Menu',groups:[{blocks:[{id:'hello',type:'text',content:{text:'Olá'}},{id:'answer',type:'textInput',content:{label:'Nome'}}]}]}));expect(result.graph.nodes.map(node=>node.type)).toEqual(['start','message','input','end','unsupported']);expect(result.report.summary.partial).toBe(2);expect(result.report.summary.autoPublished).toBe(false);});
});

it('persists a review blocker in partial imports, including an otherwise valid linear graph',()=>{
 const result=convertAutomationArtifact('AUTO',JSON.stringify({name:'Dois grupos',groups:[{blocks:[{id:'one',type:'text',content:{text:'Um'}}]},{blocks:[{id:'two',type:'text',content:{text:'Dois'}}]}]}));
 expect(validateAutomationGraph(result.graph).length).toBeGreaterThan(0);
 expect(result.graph.nodes.some(n=>n.type==='unsupported'&&n.data.sourceType==='IMPORT_REVIEW_REQUIRED')).toBe(true);
});

it('keeps partial protection when an external workflow is wrapped in a JRC export',()=>{
 const workflow={name:'Importada',nodes:[{id:'a',name:'Entrada',type:'n8n-nodes-base.webhook',position:[0,0],parameters:{}},{id:'b',name:'Resposta',type:'n8n-nodes-base.respondToWebhook',position:[200,0],disabled:true,parameters:{respondWith:'text',responseBody:'Olá'}}],connections:{Entrada:{main:[[{node:'Resposta',type:'main',index:0}]]}}};
 for(const source of ['AUTO','JRC'] as const){const result=convertAutomationArtifact(source,JSON.stringify({format:'jrc-flows/2',flow:{engine:'workflow',name:'Importada'},workflow}));expect(result.report.summary.manualReviewRequired).toBe(true);expect(result.report.summary.exact).toBe(0);expect(validateAutomationGraph(result.graph).length).toBeGreaterThan(0);}
});

it('normalizes large n8n canvas coordinates without losing node spacing',()=>{
 const workflow={name:'Large canvas',nodes:[
  {id:'start',name:'Webhook',type:'n8n-nodes-base.webhook',position:[108128,42544],parameters:{}},
  {id:'logic',name:'Logic',type:'n8n-nodes-base.code',position:[111440,44624],parameters:{jsCode:'return $input.all()'}},
 ],connections:{Webhook:{main:[[{node:'Logic',type:'main',index:0}]]}}};
 const result=convertAutomationArtifact('N8N',JSON.stringify(workflow));
 const [start,logic]=result.graph.nodes;
 expect(start?.position).toEqual({x:60,y:80});
 expect(logic?.position).toEqual({x:3372,y:2160});
 expect(result.report.warnings).toContain('Posições do canvas n8n foram ajustadas para caber no editor JRC.');
 expect(result.report.summary).toMatchObject({partial:1,unsupported:1,manualReviewRequired:true});
});

it('keeps distinct positions valid across a very wide or overflowing canvas',()=>{
 for(const values of [[0,100,1e9],[-1e308,0,1e308]]){
  const nodes=values.map((x,index)=>({id:`node-${index}`,name:`Node ${index}`,type:'n8n-nodes-base.code',position:[x,x],parameters:{}}));
  const result=convertAutomationArtifact('N8N',JSON.stringify({name:'Extreme canvas',nodes,connections:{}}));
  const positions=result.graph.nodes.slice(0,3).map(node=>node.position);
  expect(positions.every(position=>Number.isFinite(position.x)&&Number.isFinite(position.y)&&position.x<=100000&&position.y<=100000)).toBe(true);
  expect(new Set(positions.map(position=>position.x)).size).toBe(3);
  expect(new Set(positions.map(position=>position.y)).size).toBe(3);
 }
});

it('keeps disabled n8n triggers inert and calls out the disabled state',()=>{
 const workflow={name:'Disabled trigger',nodes:[
  {id:'start',name:'Webhook',type:'n8n-nodes-base.webhook',disabled:true,position:[0,0],parameters:{}},
 ],connections:{}};
 const result=convertAutomationArtifact('N8N',JSON.stringify(workflow));
 expect(result.graph.nodes[0]?.type).toBe('unsupported');
 expect(result.report.summary).toMatchObject({partial:0,unsupported:1,manualReviewRequired:true});
 expect(result.report.nodes[0]?.notes).toContain('Nó desabilitado na origem; reative somente após revisão.');
});

it('keeps the import graph within 150 nodes when the source uses the full limit',()=>{
 const nodes=Array.from({length:150},(_,index)=>({id:`node-${index}`,name:`Node ${index}`,type:index===0?'n8n-nodes-base.webhook':'n8n-nodes-base.code',position:[index*200,0],parameters:{}}));
 const result=convertAutomationArtifact('N8N',JSON.stringify({name:'Large flow',nodes,connections:{}}));
 expect(result.report.summary.total).toBe(150);
 expect(result.graph.nodes).toHaveLength(150);
 expect(result.report.summary.manualReviewRequired).toBe(true);
 expect(validateAutomationGraph(result.graph).length).toBeGreaterThan(0);
});

it('keeps a review blocker at the node limit even if all source nodes map to native types',()=>{
 const nodes=Array.from({length:150},(_,index)=>({id:`node-${index}`,name:`Node ${index}`,type:index===0?'n8n-nodes-base.webhook':'n8n-nodes-base.noOp',position:[index*200,0],parameters:{}}));
 const result=convertAutomationArtifact('N8N',JSON.stringify({name:'Native-looking import',nodes,connections:{}}));
 expect(result.graph.nodes).toHaveLength(150);
 expect(result.graph.nodes.some(node=>node.type==='unsupported')).toBe(true);
 expect(validateAutomationGraph(result.graph).length).toBeGreaterThan(0);
});
