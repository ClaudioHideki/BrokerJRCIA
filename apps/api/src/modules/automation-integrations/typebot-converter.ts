import {FlowGraphSchema, type AutomationGraphV1, type FlowNode} from '@jrc/contracts';
import type {ImportNodeReport} from './importer.js';

const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const string=(value:unknown)=>typeof value==='string'?value:'';
const list=(value:unknown):Record<string,unknown>[]=>Array.isArray(value)?value.map(record):[];

function richText(value:unknown):string {
  if(typeof value==='string')return value;
  const inline=(node:Record<string,unknown>):string=>string(node.text)||list(node.children).map(inline).join('');
  return list(value).map(inline).join('\n');
}

/** Migration only: external effects remain inert, and the caller adds the review gate. */
export function convertTypebot(document:Record<string,unknown>):{name:string;graph:AutomationGraphV1;nodes:ImportNodeReport[]} {
  const groups=list(document.groups),blocks=groups.flatMap(group=>list(group.blocks));
  const structured=Object.hasOwn(document,'edges')||Object.hasOwn(document,'events')||blocks.some(block=>
    Boolean(block.outgoingEdgeId)||list(block.items??record(block.content).items).some(item=>Boolean(item.outgoingEdgeId)));
  if(structured&&groups.some(group=>!string(group.id)))throw new Error('TYPEBOT_GROUP_ID_INVALID');
  const definitions=new Map(list(document.variables).map(variable=>[string(variable.id),string(variable.name)]));
  const variables=(id:unknown,fallback:string)=>{
    const reference=string(id),name=definitions.get(reference)||reference||fallback;
    if(!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,99}$/.test(name)||name.split('.').some(part=>['__proto__','prototype','constructor'].includes(part)))throw new Error('TYPEBOT_VARIABLE_UNSUPPORTED');
    return name;
  };
  const sourceIds=blocks.map(block=>string(block.id));
  if(sourceIds.some(id=>id.length>100)||new Set(sourceIds.filter(Boolean)).size!==sourceIds.filter(Boolean).length)throw new Error('TYPEBOT_BLOCK_ID_INVALID');
  const ids=new Set(sourceIds);
  let generated=0;
  const unique=(prefix:string)=>{let id=prefix;while(ids.has(id))id=`${prefix}-${++generated}`;ids.add(id);return id;};
  const start=unique('start'),end=unique('end');
  const nodes:FlowNode[]=[{id:start,type:'start',label:'Início importado',position:{x:40,y:120},data:{}}];
  const reports:ImportNodeReport[]=[];
  for(const [index,block] of blocks.entries()) {
    const id=string(block.id)||unique(`typebot-${index}`),type=string(block.type),content=record(block.content),options=record(block.options);
    const node:FlowNode={id,type:'unsupported',label:(string(content.label||content.text)||type||`Bloco ${index+1}`).slice(0,160),position:{x:300+(index%8)*260,y:120+Math.floor(index/8)*240},data:{sourceType:type}};
    const report:ImportNodeReport={sourceId:id,sourceType:type||'unknown',classification:'UNSUPPORTED',targetType:null,notes:[]};
    if(['text','textBubble'].includes(type)) {
      const text=richText(content.richText??content.text??block.text);
      if(text.trim()&&text.length<=4096){node.type='message';node.data={text};report.classification='PARTIAL';report.notes.push('Texto preservado; revise a apresentação no canal.');}
    }else if(['text input','textInput','input'].includes(type)) {
      node.type='input';node.data={text:string(options.placeholder||content.placeholder||content.label),variable:variables(options.variableId??content.variableId,`resposta_${index+1}`)};
      report.classification='PARTIAL';report.notes.push('Validações específicas do Typebot exigem revisão.');
    }else if(['choice input','choiceInput','buttons'].includes(type)) {
      const items=list(block.items??content.items),choices=items.map((item,i)=>({value:String(i+1),label:string(item.content||item.label)}));
      if(choices.length>=2&&choices.length<=10&&choices.every(choice=>choice.label.trim()&&choice.label.length<=120)) {
        node.type='menu';node.data={text:string(content.label)||'Escolha uma opção',variable:variables(options.variableId??content.variableId,`opcao_${index+1}`),options:choices};
        report.classification='PARTIAL';report.notes.push(structured?'Caminhos preservados pelas referências atuais dos itens.':'Sem grafo de origem; reconecte os caminhos antes de publicar.');
      }
    }else if(['set variable','setVariable'].includes(type)) {
      node.type='variable';node.data={variable:variables(options.variableId??content.variableId,`variavel_${index+1}`),value:string(options.value??content.value)};
      report.classification='PARTIAL';report.notes.push('Expressões externas foram mantidas como texto.');
    }
    if(report.classification==='UNSUPPORTED')report.notes.push('Ação sem equivalência automática. Configure o bloco nativo e o destino autorizado antes de publicar.');
    else report.targetType=node.type;
    nodes.push(node);reports.push(report);
  }
  nodes.push({id:end,type:'end',label:'Encerrar',position:{x:40,y:600},data:{}});
  const edges:AutomationGraphV1['edges']=[];
  const connect=(source:string,target:string,port='next')=>edges.push({id:unique('typebot-edge'),source,target,port});
  if(!structured) {
    const compatible=nodes.filter(node=>node.type!=='unsupported');
    compatible.slice(0,-1).forEach((node,i)=>connect(node.id,compatible[i+1]!.id,node.type==='menu'?'option-1':'next'));
  }else {
    const byGroup=new Map(groups.map(group=>[string(group.id),group]));
    if(byGroup.size!==groups.length)throw new Error('TYPEBOT_GROUP_ID_INVALID');
    const sourceEdges=list(document.edges),byEdge=new Map(sourceEdges.map(edge=>[string(edge.id),edge]));
    if(byEdge.size!==sourceEdges.length)throw new Error('TYPEBOT_EDGE_DUPLICATE');
    const target=(reference:unknown,expected:Record<string,string>):string=>{
      const edge=byEdge.get(string(reference)),from=record(edge?.from),to=record(edge?.to);
      if(!edge||Object.entries(expected).some(([key,value])=>from[key]!==value))throw new Error('TYPEBOT_EDGE_SOURCE_INVALID');
      const group=byGroup.get(string(to.groupId)),members=list(group?.blocks);
      const block=to.blockId?members.find(member=>member.id===to.blockId):members[0];
      // Members are normalized again, so resolve by stable source ID.
      const destination=block&&nodes.find(node=>node.id===block.id);
      if(!destination)throw new Error('TYPEBOT_EDGE_TARGET_INVALID');
      return destination.id;
    };
    const starts=list(document.events).filter(event=>event.type==='start');
    if(starts.length!==1||!starts[0]?.outgoingEdgeId)throw new Error('TYPEBOT_START_EDGE_INVALID');
    connect(start,target(starts[0].outgoingEdgeId,{eventId:string(starts[0].id)}));
    for(const group of groups) {
      const members=list(group.blocks);
      for(const [index,block] of members.entries()) {
        const node=nodes.find(candidate=>candidate.id===block.id)!;
        if(!node)throw new Error('TYPEBOT_BLOCK_ID_INVALID');
        const following=string(members[index+1]?.id)||end;
        if(node.type==='menu') {
          const content=record(block.content),items=list(block.items??content.items),variableId=record(block.options).variableId??content.variableId;
          for(const [choiceIndex,item] of items.entries()) {
            const destination=item.outgoingEdgeId?target(item.outgoingEdgeId,{blockId:node.id,itemId:string(item.id)})
              :block.outgoingEdgeId?target(block.outgoingEdgeId,{blockId:node.id}):following;
            if(variableId) {
              const assignId=unique('typebot-choice'),choice=record((node.data.options as unknown[])[choiceIndex]);
              nodes.push({id:assignId,type:'variable',label:'Guardar escolha',position:{x:node.position.x+120,y:node.position.y+80+choiceIndex*40},data:{variable:node.data.variable,value:choice.label}});
              connect(node.id,assignId,`option-${choiceIndex+1}`);connect(assignId,destination);
            }else connect(node.id,destination,`option-${choiceIndex+1}`);
          }
        }else if(node.type!=='unsupported')connect(node.id,block.outgoingEdgeId?target(block.outgoingEdgeId,{blockId:node.id}):following);
        // Unsupported effects intentionally have no synthesized continuation.
      }
    }
  }
  if(nodes.length>=150||edges.length>300)throw new Error('TYPEBOT_CONVERSION_LIMIT');
  return {name:string(document.name).slice(0,120)||'Automação importada',graph:FlowGraphSchema.parse({nodes,edges}),nodes:reports};
}
