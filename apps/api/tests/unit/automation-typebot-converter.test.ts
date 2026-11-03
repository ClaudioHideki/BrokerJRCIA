import {describe, expect, it} from 'vitest';
import {convertAutomationArtifact} from '../../src/modules/automation-integrations/importer.js';
import {executeAutomation} from '../../src/modules/automations/engine.js';
import type {PublishedAutomation} from '../../src/modules/automations/types.js';

// Synthetic export: the shape matches grouped exports; no customer data or credentials.
const artifact = () => ({
  name: 'Bilingual HML',
  variables: [{id:'department-id',name:'department'}],
  events: [{id:'entry',type:'start',outgoingEdgeId:'entry-edge'}],
  groups: [
    {id:'finish',blocks:[{id:'confirmation',type:'text',content:{richText:[{type:'p',children:[{text:'Selected: '},{text:'{{department}}'}]}]}}]},
    {id:'welcome',blocks:[
      {id:'hello',type:'text',content:{richText:[{type:'p',children:[{text:'Welcome'}]},{type:'p',children:[{text:'Choose a department'}]}]}},
      {id:'menu',type:'choice input',options:{variableId:'department-id'},items:[
        {id:'sales',content:'Sales',outgoingEdgeId:'sales-edge'},
        {id:'support',content:'Support',outgoingEdgeId:'support-edge'},
        {id:'back',content:'Back',outgoingEdgeId:'back-edge'},
      ]},
    ]},
    {id:'integration',blocks:[{id:'external',type:'Webhook',options:{webhook:{url:'https://legacy.invalid/hangoff',body:'{"token":"do-not-copy"}'}}}]},
  ],
  edges: [
    {id:'entry-edge',from:{eventId:'entry'},to:{groupId:'welcome'}},
    {id:'sales-edge',from:{blockId:'menu',itemId:'sales'},to:{groupId:'finish'}},
    {id:'support-edge',from:{blockId:'menu',itemId:'support'},to:{groupId:'integration'}},
    {id:'back-edge',from:{blockId:'menu',itemId:'back'},to:{groupId:'welcome',blockId:'menu'}},
    // Historical edges are not executable when no current item/event references them.
    {id:'obsolete',from:{blockId:'deleted'},to:{groupId:'finish'}},
  ],
});

describe('grouped Typebot migration',()=>{
  it('extracts paragraph text and maps choices from block.items to named variables',()=>{
    const {graph}=convertAutomationArtifact('AUTO',JSON.stringify(artifact()));
    expect(graph.nodes.find(n=>n.id==='hello')?.data.text).toBe('Welcome\nChoose a department');
    expect(graph.nodes.find(n=>n.id==='menu')?.data).toMatchObject({variable:'department',options:[{value:'1',label:'Sales'},{value:'2',label:'Support'},{value:'3',label:'Back'}]});
  });

  it('starts at the declared event and follows labels and return-to-block paths at runtime',async()=>{
    const {graph}=convertAutomationArtifact('TYPEBOT',JSON.stringify(artifact()));
    const published={automationId:'hml',version:1,graph,runtimeStateVersion:2} as PublishedAutomation;
    const input={eventType:'MESSAGE' as const,text:'hello',now:new Date('2026-11-03T12:00:00Z')};
    const first=await executeAutomation(published,input,async()=>published);
    expect(first.effects.map(e=>e.payload.text)).toEqual(['Welcome\nChoose a department','Escolha uma opção\n1 - Sales\n2 - Support\n3 - Back']);
    const back=await executeAutomation(published,{...input,text:'3'},async()=>published,first.state);
    expect(back.state.waiting?.nodeId).toBe('menu');
    expect(back.effects).toHaveLength(1);
    const chosen=await executeAutomation(published,{...input,text:'1'},async()=>published,back.state);
    expect(chosen.effects.map(e=>e.payload.text)).toEqual(['Selected: Sales']);
    expect(chosen.status).toBe('COMPLETED');
  });

  it('retains unsupported external actions on their own branch without copying their URL or body',()=>{
    const {graph,report}=convertAutomationArtifact('TYPEBOT',JSON.stringify(artifact()));
    const choice=graph.edges.find(e=>e.source==='menu'&&e.port==='option-2');
    expect(choice).toBeDefined();
    const assignment=graph.nodes.find(n=>n.id===choice?.target)!;
    expect(assignment.data).toMatchObject({variable:'department',value:'Support'});
    expect(graph.edges.find(e=>e.source===assignment.id)?.target).toBe('external');
    expect(graph.nodes.find(n=>n.id==='external')?.type).toBe('unsupported');
    expect(JSON.stringify(graph)).not.toMatch(/legacy\.invalid|do-not-copy/);
    expect(report.summary).toMatchObject({autoPublished:false,manualReviewRequired:true,unsupported:1});
  });

  it('refuses a referenced edge whose source does not match the current item',()=>{
    const source=artifact();source.edges[1]!.from={blockId:'another-block',itemId:'sales'};
    expect(()=>convertAutomationArtifact('TYPEBOT',JSON.stringify(source))).toThrow(/TYPEBOT.*EDGE/);
  });

  it('does not reconnect an explicitly broken reference as a linear flow',()=>{
    const source=artifact();source.edges=source.edges.filter(e=>e.id!=='support-edge');
    expect(()=>convertAutomationArtifact('TYPEBOT',JSON.stringify(source))).toThrow(/TYPEBOT.*EDGE/);
  });
});
