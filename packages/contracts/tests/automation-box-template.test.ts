import {it,expect} from 'vitest';
import {oiaVisualReconstructionFlow,OIA_DEPARTMENTS} from '../src/oia-visual-reconstruction.js';
import {convertOiaToBoxTemplate,oiaBoxTemplateFlow} from '../src/automation-box-template.js';
import {validateAutomationGraph} from '../src/automations-v1.js';
it('explicitly converts OIA without modifying its source, preserves hours/back/retry and removes static people',()=>{
 const original=oiaVisualReconstructionFlow(),encoded=JSON.stringify(original),next=convertOiaToBoxTemplate(original);
 expect(JSON.stringify(original)).toBe(encoded);expect(validateAutomationGraph(next)).toEqual([]);
 expect(next.nodes.find(n=>n.type==='schedule')?.data).toEqual(original.nodes.find(n=>n.type==='schedule')?.data);
 expect(next.nodes.filter(n=>n.type==='directory-menu')).toHaveLength(8);
 expect(next.nodes.filter(n=>n.type==='handoff')).toHaveLength(4);
 expect(next.nodes.filter(n=>n.type==='handoff').every(n=>n.data.handoffVersion===3)).toBe(true);
 expect(JSON.stringify(next)).not.toContain('HML Comercial 1');
 for(const d of OIA_DEPARTMENTS)for(const l of ['pt','en']){
  expect(next.edges.find(e=>e.source===`attendants-${d.id}-${l}`&&e.port==='back')?.target).toBe(`departments-${l}`);
  expect(next.nodes.find(n=>n.id===`attendants-${d.id}-${l}`)?.data).toMatchObject({maxAttempts:3,timeoutSeconds:300,language:l});
 }
});
it('rejects ambiguous modifications and hidden subflows rather than partially converting',()=>{
 const changed=oiaVisualReconstructionFlow();changed.edges.find(e=>e.source==='announce-sales-1-pt')!.target='end';
 expect(()=>convertOiaToBoxTemplate(changed)).toThrow('FLOW_BOX_OIA_CONVERSION_REQUIRED');
 const hidden=oiaVisualReconstructionFlow();hidden.nodes.push({id:'extra',type:'subflow',label:'extra',position:{x:0,y:0},data:{}});
 expect(()=>convertOiaToBoxTemplate(hidden)).toThrow('FLOW_BOX_OIA_CONVERSION_REQUIRED');
 expect(validateAutomationGraph(oiaBoxTemplateFlow())).toEqual([]);
});
it('rejects unrecognized announcement content instead of silently deleting customer instructions',()=>{
 const graph=oiaVisualReconstructionFlow();graph.nodes.find(n=>n.id==='announce-sales-1-pt')!.data.text='Leia os termos antes de continuar.';
 expect(()=>convertOiaToBoxTemplate(graph)).toThrow('FLOW_BOX_OIA_CONVERSION_REQUIRED');
});
