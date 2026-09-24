import { FlowGraphSchema, type FlowNode, type AutomationGraphV1 } from '@jrc/contracts';
import type { ImportNodeReport } from './importer.js';

const object = (value:unknown):Record<string,unknown> => value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
const text = (value:unknown) => typeof value==='string' ? value : typeof value==='number' ? String(value) : '';
const operators = new Set(['equals','not_equals','contains','starts_with','present']);

export function isLocalJrcFlow(document:Record<string,unknown>):boolean {
  const flow=object(document.flow);
  return ['jrc-flows/1','jrc-flows/2'].includes(text(document.format)) &&
    (flow.engine==='native' || Object.hasOwn(flow,'settings') || Object.hasOwn(flow,'kind'));
}

/** Converts a local JRC graph into an editable draft. It never carries account or inbox IDs. */
export function convertLocalJrcFlow(document:Record<string,unknown>):{name:string;graph:AutomationGraphV1;nodes:ImportNodeReport[]} {
  const flow=object(document.flow), source=FlowGraphSchema.parse(flow.graph);
  const graph:AutomationGraphV1={nodes:[],edges:source.edges.map(edge=>({...edge}))};
  const reports:ImportNodeReport[]=[];
  const ids=new Set([...source.nodes.map(node=>node.id),...source.edges.map(edge=>edge.id)]);
  let sequence=0;
  const unique=()=>{let id:string;do{id=`jrc-converted-${++sequence}`;}while(ids.has(id));ids.add(id);return id;};
  const rule=(data:Record<string,unknown>)=>({field:text(data.field)||'message',operator:text(data.operator),value:text(data.value),comparisonMode:'JRC_NORMALIZED'});
  for(const original of source.nodes) {
    const node:FlowNode={...original,data:{sourceType:original.type},type:'unsupported'};
    const report:ImportNodeReport={sourceId:original.id,sourceType:original.type,classification:'UNSUPPORTED',targetType:null,notes:[]};
    const data=original.data;
    if(['start','end'].includes(original.type)) {node.type=original.type;node.data={};report.classification='EXACT';}
    if(original.type==='message') {node.type='message';node.data={text:text(data.text)};report.classification='EXACT';}
    if(original.type==='variable') {node.type='variable';node.data={variable:text(data.variable),value:text(data.value)};report.classification='EXACT';}
    if(original.type==='condition' && operators.has(text(data.operator))) {node.type='condition';node.data=rule(data);report.classification='EXACT';}
    if(original.type==='delay') {
      node.type='delay';node.data={seconds:data.seconds};report.classification='PARTIAL';
      report.notes.push('Revise a interrupção por resposta do cliente: a política stop_on_reply da origem não é transferida.');
    }
    if(original.type==='switch') {
      const cases=Array.isArray(data.cases)?data.cases.map(object):[];
      const paths=source.edges.filter(edge=>edge.source===original.id);
      const ports=cases.map(item=>text(item.id));
      const valid=cases.length>0 && cases.length<=10 && new Set(ports).size===ports.length && !ports.includes('fallback') &&
        cases.every(item=>text(item.id) && operators.has(text(item.operator))) &&
        [...ports,'fallback'].every(port=>paths.filter(edge=>edge.port===port).length===1) && paths.length===cases.length+1;
      if(valid) {
        const chain=cases.map((item,index):FlowNode=>({id:index===0?original.id:unique(),type:'condition',label:original.label,position:{x:original.position.x,y:Math.min(100000,original.position.y+index*140)},data:rule(item)}));
        Object.assign(node,chain[0]);
        graph.nodes.push(...chain.slice(1));
        graph.edges=graph.edges.filter(edge=>edge.source!==original.id);
        chain.forEach((condition,index)=>{
          graph.edges.push({id:unique(),source:condition.id,port:'yes',target:paths.find(edge=>edge.port===ports[index])!.target});
          graph.edges.push({id:unique(),source:condition.id,port:'no',target:chain[index+1]?.id??paths.find(edge=>edge.port==='fallback')!.target});
        });
        report.classification='EXACT';report.notes.push('Switch convertido em condições ordenadas, preservando a primeira regra correspondente.');
      }
    }
    if(report.classification==='UNSUPPORTED') report.notes.push(original.type==='input'
      ? 'Captura local com prazo e saída timeout exige adaptação; esses caminhos não foram descartados.'
      : original.type==='assign' ? 'Selecione o destino humano desta empresa; IDs de equipe ou agente da origem não são reutilizados.'
      : 'Este bloco exige um adaptador equivalente antes da publicação. O original permanece no artefato criptografado.');
    else report.targetType=node.type;
    if(original.type==='start') {
      report.classification='PARTIAL';
      report.notes.push('Selecione as caixas desta empresa e revise gatilho, horários, pausa humana e reinício. As configurações da origem não ativam a automação.');
    }
    graph.nodes.push(node);reports.push(report);
  }
  // Reserve one slot for the mandatory review marker.
  if(graph.nodes.length>=150 || graph.edges.length>300) throw new Error('A conversão excede o limite de 150 blocos ou 300 conexões. Divida o fluxo antes de importar.');
  return {name:text(flow.name).slice(0,120)||'Automação JRC importada',graph:FlowGraphSchema.parse(graph),nodes:reports};
}
