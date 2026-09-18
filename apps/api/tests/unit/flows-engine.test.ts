import { describe, expect, it } from 'vitest';
import { validateFlow, executeFlow, importFlow, welcomeFlow } from '@jrc/contracts';

describe('native JRC Flows', () => {
  it('runs a complete welcome flow and never needs an external bot service', async () => {
    const graph = welcomeFlow();
    expect(validateFlow(graph)).toEqual([]);
    const result = executeFlow(graph, { text: 'Olá', variables: { 'contact.name': 'Ana' } });
    expect(result.status).toBe('completed');
    expect(result.texts).toEqual(['Olá, Ana! Como podemos ajudar?']);
    expect(result.trace.map(x => x.type)).toEqual(['start', 'message', 'end']);
  });
  it('waits for a new turn, persists the answer and follows the correct branch', () => {
    const graph = { nodes: [
      { id: 's', type: 'start', label: 'Início', position: {x:0,y:0}, data: {} },
      { id: 'q', type: 'input', label: 'Pergunta', position: {x:200,y:0}, data: {text:'Qual setor?', variable:'setor'} },
      { id: 'c', type: 'condition', label: 'Condição', position: {x:400,y:0}, data: {field:'setor', operator:'equals', value:'1'} },
      { id: 'a', type: 'message', label: 'Comercial', position: {x:600,y:0}, data: {text:'Comercial: {{setor}}'} },
      { id: 'b', type: 'message', label: 'Suporte', position: {x:600,y:200}, data: {text:'Suporte'} },
      { id: 'e', type: 'end', label: 'Fim', position: {x:800,y:0}, data: {} },
    ], edges: [
      {id:'1',source:'s',target:'q',port:'next'}, {id:'2',source:'q',target:'c',port:'next'},
      {id:'3',source:'c',target:'a',port:'yes'}, {id:'4',source:'c',target:'b',port:'no'},
      {id:'5',source:'a',target:'e',port:'next'}, {id:'6',source:'b',target:'e',port:'next'},
    ]};
    expect(validateFlow(graph)).toEqual([]);
    const first = executeFlow(graph, {text:'oi'});
    expect(first).toMatchObject({status:'waiting', nodeId:'q', texts:['Qual setor?']});
    const next = executeFlow(graph, {text:'1', state:first});
    expect(next).toMatchObject({status:'completed', texts:['Comercial: 1'], variables:{setor:'1'}});
  });
  it('renders a WhatsApp menu, retries invalid choices and follows the selected option', () => {
    const graph = { nodes: [
      {id:'s',type:'start',label:'Início',position:{x:0,y:0},data:{}},
      {id:'m',type:'menu',label:'Menu',position:{x:200,y:0},data:{text:'Escolha um setor:',variable:'setor',options:[{value:'1',label:'Comercial'},{value:'2',label:'Suporte'}]}},
      {id:'a',type:'message',label:'Comercial',position:{x:400,y:0},data:{text:'Você escolheu Comercial'}},
      {id:'b',type:'handoff',label:'Suporte humano',position:{x:400,y:200},data:{}},
      {id:'e',type:'end',label:'Fim',position:{x:600,y:0},data:{}},
    ], edges: [
      {id:'1',source:'s',target:'m',port:'next'}, {id:'2',source:'m',target:'a',port:'option-1'},
      {id:'3',source:'m',target:'b',port:'option-2'}, {id:'4',source:'a',target:'e',port:'next'},
    ]};
    expect(validateFlow(graph)).toEqual([]);
    const first=executeFlow(graph,{text:'oi'});
    expect(first).toMatchObject({status:'waiting',nodeId:'m',texts:['Escolha um setor:\n1 - Comercial\n2 - Suporte']});
    const retry=executeFlow(graph,{text:'x',state:first});
    expect(retry).toMatchObject({status:'waiting',nodeId:'m'});
    expect(retry.texts[0]).toContain('Responda com o número');
    const selected=executeFlow(graph,{text:'1',state:first});
    expect(selected).toMatchObject({status:'completed',variables:{setor:'1'},texts:['Você escolheu Comercial']});
  });
  it('rejects bad edges, unsupported nodes and infinite paths at publication', () => {
    const graph=welcomeFlow();
    graph.edges[0]!.target='missing';
    expect(validateFlow(graph).join(' ')).toMatch(/inexistente/);
    graph.edges[0]!.target=graph.nodes[1]!.id;
    graph.nodes[1]!.type='arbitrary-code';
    expect(validateFlow(graph).join(' ')).toMatch(/suportado/);
    graph.nodes[1]!.type='message';
    graph.edges[1]!.target=graph.nodes[1]!.id;
    expect(validateFlow(graph).join(' ')).toMatch(/ciclo/);
  });
  it('does not evaluate template JavaScript or resolve prototype properties', () => {
    const graph=welcomeFlow();
    graph.nodes[1]!.data.text='{{ process.env.KEY }} / {{constructor}} / {{contact.name}}';
    const output=executeFlow(graph,{text:'oi',variables:{'contact.name':'Ana'}});
    expect(output.texts[0]).toBe(' /  / Ana');
  });
  it('imports JRC JSON without account, channel or credentials from another tenant', () => {
    const imported=importFlow(JSON.stringify({format:'jrc-flows/2',flow:{name:'Boas vindas',graph:welcomeFlow(),settings:{inbox_ids:[99]},secrets:{key:'test-secret'}}}));
    expect(imported.name).toBe('Boas vindas');
    expect(imported.graph.nodes).toHaveLength(3);
    expect(JSON.stringify(imported)).not.toContain('test-secret');
    expect(JSON.stringify(imported)).not.toContain('inbox_ids');
  });
  it('imports n8n unsupported nodes as explicit blockers, never pretending they run', () => {
    const result=importFlow(JSON.stringify({name:'Imported',nodes:[
      {id:'a',name:'Webhook',type:'n8n-nodes-base.webhook',position:[0,0],parameters:{}},
      {id:'b',name:'Postgres',type:'n8n-nodes-base.postgres',position:[200,0],parameters:{},credentials:{postgres:{id:'remote'}}}
    ],connections:{Webhook:{main:[[{node:'Postgres',type:'main',index:0}]]}}}));
    expect(result.graph.nodes).toHaveLength(2);
    expect(validateFlow(result.graph).join(' ')).toMatch(/Postgres/);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
