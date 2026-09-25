import { z } from 'zod';

export const FLOW_ORIGIN = 'jrc-flows-native';
const id = z.string().min(1).max(100);
export const FlowGraphSchema = z.object({
  nodes: z.array(z.object({
    id, type: z.string().min(1).max(100), label: z.string().max(160),
    position: z.object({x:z.number().finite().min(-10000).max(100000),y:z.number().finite().min(-10000).max(100000)}),
    data: z.record(z.string().max(100), z.unknown()),
  })).min(1).max(150),
  edges: z.array(z.object({id,source:id,target:id,port:id})).max(300),
}).refine(g => JSON.stringify(g).length <= 250000, 'O fluxo excede 250 KB.');
export type FlowGraph = z.infer<typeof FlowGraphSchema>;
export type FlowNode = FlowGraph['nodes'][number];
export interface FlowState { status:'waiting'|'completed'|'handoff'; nodeId:string|null; variables:Record<string,string>; steps:number }
export interface FlowResult extends FlowState { texts:string[]; trace:{nodeId:string;label:string;type:string}[] }
export const FLOW_NODE_CATALOG = [
  {type:'start', label:'Início', description:'Recebe uma mensagem do canal vinculado.'},
  {type:'message', label:'Enviar mensagem', description:'Envia texto com as variáveis da conversa.'},
  {type:'input', label:'Capturar resposta', description:'Faz uma pergunta e aguarda a próxima mensagem.'},
  {type:'menu', label:'Menu de opções', description:'Mostra opções numeradas e segue pelo caminho escolhido.'},
  {type:'condition', label:'Condição', description:'Escolhe entre os caminhos Sim e Não.'},
  {type:'variable', label:'Salvar variável', description:'Guarda um valor para usar nos próximos blocos.'},
  {type:'handoff', label:'Atendimento humano', description:'Pausa o bot e entrega a conversa ao atendente.'},
  {type:'end', label:'Encerrar', description:'Conclui esta sessão do chatbot.'},
] as const;
const dangerous = new Set(['__proto__','prototype','constructor']);
const safeKey = (value:unknown):value is string => typeof value==='string' && /^[a-zA-Z_][a-zA-Z0-9_.-]{0,99}$/.test(value) && !value.split('.').some(s=>dangerous.has(s));
const value = (x:unknown) => typeof x==='string' ? x : typeof x==='number' || typeof x==='boolean' ? String(x) : '';
export function flowPorts(node:FlowNode):string[] {
  if (node.type==='condition') return ['yes','no'];
  if (node.type==='menu') return menuOptions(node).map(option=>'option-'+option.value);
  return ['end','handoff'].includes(node.type) ? [] : ['next'];
}
export interface FlowMenuOption { value:string; label:string }
export function menuOptions(node:FlowNode):FlowMenuOption[]{
  if(node.type!=='menu'||!Array.isArray(node.data.options))return [];
  return node.data.options.flatMap(raw=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return [];
    const option=raw as Record<string,unknown>, optionValue=value(option.value).trim(), label=value(option.label).trim();
    return /^[1-9][0-9]{0,1}$/.test(optionValue)&&label&&label.length<=120?[{value:optionValue,label}]:[];
  });
}
export function validateFlow(input:unknown):string[] {
  const parsed=FlowGraphSchema.safeParse(input);
  if(!parsed.success) return ['Formato de fluxo inválido: confira blocos, posições e conexões (até 150 blocos).'];
  const graph=parsed.data, errors:string[]=[];
  const ids=new Set(graph.nodes.map(n=>n.id));
  if(ids.size!==graph.nodes.length) errors.push('Os identificadores dos blocos devem ser únicos.');
  if(new Set(graph.edges.map(e=>e.id)).size!==graph.edges.length) errors.push('Os identificadores das conexões devem ser únicos.');
  if(graph.nodes.filter(n=>n.type==='start').length!==1) errors.push('O fluxo precisa de exatamente um início.');
  if(graph.edges.some(e=>!ids.has(e.source)||!ids.has(e.target))) errors.push('Conexão aponta para um bloco inexistente.');
  const ports=new Set<string>();
  for(const edge of graph.edges){
    const key=JSON.stringify([edge.source,edge.port]);
    if(ports.has(key)) errors.push('Cada saída permite uma única conexão.');
    ports.add(key);
    const from=graph.nodes.find(n=>n.id===edge.source),to=graph.nodes.find(n=>n.id===edge.target);
    if(from&&!flowPorts(from).includes(edge.port)) errors.push(from.label+': saída inválida.');
    if(to?.type==='start') errors.push('Uma conexão não pode retornar ao início.');
  }
  for(const n of graph.nodes){
    if(!FLOW_NODE_CATALOG.some(c=>c.type===n.type)) {errors.push(n.label+': tipo '+n.type+' ainda não suportado.');continue;}
    for(const port of flowPorts(n)) if(!graph.edges.some(e=>e.source===n.id&&e.port===port)) errors.push(n.label+': conecte a saída '+port+'.');
    if(n.type==='message' && (!value(n.data.text).trim() || value(n.data.text).length>4096)) errors.push(n.label+': informe uma mensagem de até 4096 caracteres.');
    if(['input','variable'].includes(n.type)&&!safeKey(n.data.variable)) errors.push(n.label+': nome de variável inválido.');
    if(n.type==='input'&&value(n.data.text).length>4096) errors.push(n.label+': pergunta muito longa.');
    if(n.type==='input'&&Number(n.data.timeout??0)>0) errors.push(n.label+': timeout importado ainda não suportado.');
    if(n.type==='menu'){
      const options=menuOptions(n), raw=Array.isArray(n.data.options)?n.data.options:[];
      if(!value(n.data.text).trim()||value(n.data.text).length>4096)errors.push(n.label+': informe a mensagem do menu.');
      if(options.length<2||options.length>10||options.length!==raw.length||new Set(options.map(option=>option.value)).size!==options.length)errors.push(n.label+': configure de 2 a 10 opções numeradas e únicas.');
    }
    if(n.type==='condition'&&(!safeKey(n.data.field)||!['equals','not_equals','contains','starts_with','present'].includes(value(n.data.operator)))) errors.push(n.label+': configure o campo e a comparação.');
  }
  const reachable=new Set<string>(), active=new Set<string>(), visited=new Set<string>();
  const walk=(current:string)=>{if(reachable.has(current))return;reachable.add(current);for(const e of graph.edges.filter(e=>e.source===current))walk(e.target);};
  const start=graph.nodes.find(n=>n.type==='start');if(start)walk(start.id);
  if(graph.nodes.some(n=>!reachable.has(n.id))) errors.push('Há blocos sem caminho a partir do início.');
  const cycles=(current:string):boolean=>{
    if(active.has(current))return true;if(visited.has(current))return false;
    visited.add(current);active.add(current);
    const node=graph.nodes.find(n=>n.id===current);
    if(node?.type!=='input')for(const e of graph.edges.filter(e=>e.source===current))if(cycles(e.target))return true;
    active.delete(current);return false;
  };
  if(graph.nodes.some(n=>cycles(n.id)))errors.push('Há um ciclo sem captura de resposta. Inclua uma espera por nova mensagem.');
  return [...new Set(errors)];
}
export function renderFlowText(text:unknown, variables:Record<string,string>):string{
  return value(text).replace(/\{\{\s*([^{}]+?)\s*\}\}/g,(_all:string,key:string)=>safeKey(key.trim())&&Object.hasOwn(variables,key.trim())?variables[key.trim()]!:'').slice(0,4096);
}
export function executeFlow(graph:FlowGraph,input:{text:string;variables?:Record<string,string>;state?:FlowState}):FlowResult{
  const errors=validateFlow(graph);if(errors.length)throw new Error(errors[0]);
  const variables:Record<string,string>=Object.create(null) as Record<string,string>;
  for(const [key,val] of Object.entries(input.state?.variables??input.variables??{}))if(safeKey(key))variables[key]=value(val).slice(0,4096);
  variables.message=input.text.slice(0,4096);
  const texts:string[]=[],trace:FlowResult['trace']=[], result=(status:FlowState['status'],nodeId:string|null,steps:number):FlowResult=>({status,nodeId,variables,texts,trace,steps});
  let current=input.state?.nodeId??graph.nodes.find(n=>n.type==='start')!.id, steps=input.state?.steps??0;
  const next=(nodeId:string,port='next')=>graph.edges.find(e=>e.source===nodeId&&e.port===port)!.target;
  if(input.state?.status==='completed'||input.state?.status==='handoff')return result(input.state.status,null,steps);
  if(input.state?.status==='waiting'){
    const waiting=graph.nodes.find(n=>n.id===current);
    if(!waiting||!['input','menu'].includes(waiting.type))throw new Error('Sessão de captura inválida.');
    if(waiting.type==='input'){
      variables[value(waiting.data.variable)]=input.text.slice(0,4096);current=next(waiting.id);
    }else{
      const selected=input.text.trim(), options=menuOptions(waiting), option=options.find(item=>item.value===selected);
      if(!option){
        const prompt=renderFlowText(waiting.data.text,variables), list=options.map(item=>item.value+' - '+item.label).join('\n');
        texts.push([prompt,list,'Responda com o número da opção.'].filter(Boolean).join('\n'));
        return result('waiting',waiting.id,steps);
      }
      variables[value(waiting.data.variable)||'menu.choice']=selected;
      current=next(waiting.id,'option-'+option.value);
    }
  }
  for(let turn=0;turn<100;turn++){
    if(++steps>1000)throw new Error('Limite de etapas desta conversa atingido.');
    const node=graph.nodes.find(n=>n.id===current)!;
    trace.push({nodeId:node.id,label:node.label,type:node.type});
    if(node.type==='end')return result('completed',null,steps);
    if(node.type==='handoff')return result('handoff',null,steps);
    if(node.type==='message')texts.push(renderFlowText(node.data.text,variables));
    if(node.type==='input'){
      const prompt=renderFlowText(node.data.text,variables);if(prompt.trim())texts.push(prompt);
      return result('waiting',node.id,steps);
    }
    if(node.type==='menu'){
      const prompt=renderFlowText(node.data.text,variables), list=menuOptions(node).map(item=>item.value+' - '+item.label).join('\n');
      texts.push([prompt,list].filter(Boolean).join('\n'));
      return result('waiting',node.id,steps);
    }
    if(node.type==='variable')variables[value(node.data.variable)]=renderFlowText(node.data.value,variables);
    let port='next';
    if(node.type==='condition'){
      const a=variables[value(node.data.field)]??'',b=renderFlowText(node.data.value,variables);
      const ok=node.data.operator==='present'?Boolean(a.trim()):node.data.operator==='not_equals'?a!==b:node.data.operator==='contains'?a.toLocaleLowerCase().includes(b.toLocaleLowerCase()):node.data.operator==='starts_with'?a.toLocaleLowerCase().startsWith(b.toLocaleLowerCase()):a===b;
      port=ok?'yes':'no';
    }
    current=next(node.id,port);
  }
  throw new Error('Limite de etapas por mensagem atingido.');
}
export function welcomeFlow():FlowGraph{return {nodes:[
  {id:'start',type:'start',label:'Mensagem recebida',position:{x:60,y:140},data:{}},
  {id:'welcome',type:'message',label:'Boas-vindas',position:{x:340,y:140},data:{text:'Olá, {{contact.name}}! Como podemos ajudar?'}},
  {id:'end',type:'end',label:'Encerrar',position:{x:620,y:140},data:{}},
],edges:[{id:'e1',source:'start',target:'welcome',port:'next'},{id:'e2',source:'welcome',target:'end',port:'next'}]};}
export function triageFlow():FlowGraph{return {nodes:[
  {id:'start',type:'start',label:'Mensagem recebida',position:{x:50,y:180},data:{}},
  {id:'name',type:'input',label:'Conhecer o cliente',position:{x:300,y:180},data:{text:'Olá! Qual é o seu nome?',variable:'nome'}},
  {id:'question',type:'input',label:'Motivo do contato',position:{x:550,y:180},data:{text:'Obrigado, {{nome}}. Como podemos ajudar?',variable:'pedido'}},
  {id:'handoff',type:'handoff',label:'Transferir para atendente',position:{x:800,y:180},data:{}},
],edges:[{id:'e1',source:'start',target:'name',port:'next'},{id:'e2',source:'name',target:'question',port:'next'},{id:'e3',source:'question',target:'handoff',port:'next'}]};}

export function importFlow(text:string):{name:string;graph:FlowGraph;warnings:string[]}{
  if(text.length>2000000)throw new Error('Selecione um JSON de até 2 MB.');
  let document:unknown;try{document=JSON.parse(text.replace(/^\uFEFF/,''));}catch{throw new Error('JSON inválido. Selecione o arquivo completo.');}
  const record=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
  const doc=record(document), warnings:string[]=[];
  if(['jrc-flows/1','jrc-flows/2','jrc-broker-flows/1'].includes(value(doc.format))){
    const flow=record(doc.flow);
    if(flow.engine==='workflow'&&doc.workflow)return importFlow(JSON.stringify(doc.workflow));
    return {name:value(flow.name).slice(0,120)||'Flow importado',graph:FlowGraphSchema.parse(flow.graph),warnings:['Vínculos de caixas, contas e credenciais devem ser configurados nesta empresa.']};
  }
  if(Array.isArray(doc.nodes)&&doc.connections&&typeof doc.connections==='object'){
    const names=new Map<string,string>(), nodes:FlowNode[]=[];
    const positions=doc.nodes.map(raw=>record(raw).position).filter((position):position is number[]=>
      Array.isArray(position)&&position.length===2&&position.every(coordinate=>typeof coordinate==='number'&&Number.isFinite(coordinate)));
    const xs=positions.map(position=>position[0]!),ys=positions.map(position=>position[1]!);
    const translate=positions.some(position=>position[0]! < -10000||position[0]! > 100000||position[1]! < -10000||position[1]! > 100000);
    const fitAxis=(values:number[],start:number,gap:number)=>{
      const unique=[...new Set(values)].sort((left,right)=>left-right),minimum=unique[0]??0,maximum=unique.at(-1)??0,span=maximum-minimum;
      const scale=Number.isFinite(span)&&span>0?Math.min(1,(100000-start)/span):0;
      const mapped=new Map<number,number>();let previous=start-gap;
      unique.forEach((coordinate,index)=>{
        // Extreme coordinates can overflow subtraction; rank preserves order in that case.
        const projected=Number.isFinite(span)?start+(coordinate-minimum)*scale:start+(100000-start)*index/Math.max(1,unique.length-1);
        const fitted=Math.min(100000,Math.max(Math.round(projected),previous+gap));
        mapped.set(coordinate,fitted);previous=fitted;
      });
      return mapped;
    };
    const fittedX=translate?fitAxis(xs,60,200):null,fittedY=translate?fitAxis(ys,80,120):null;
    if(translate)warnings.push('Posições do canvas n8n foram ajustadas para caber no editor JRC.');
    for(const [i,raw] of doc.nodes.entries()){
      const n=record(raw),p=record(n.parameters),nodeId=value(n.id)||'node-'+i;
      names.set(value(n.name),nodeId);
      const node:FlowNode={id:nodeId,label:value(n.name).slice(0,160)||'Nó '+i,type:'unsupported',position:{x:60+(i%4)*270,y:80+Math.floor(i/4)*150},data:{sourceType:value(n.type)}};
      if(Array.isArray(n.position)&&n.position.length===2&&n.position.every(v=>typeof v==='number'&&Number.isFinite(v)))node.position=translate?
        {x:fittedX!.get(Number(n.position[0]))!,y:fittedY!.get(Number(n.position[1]))!}:
        {x:Number(n.position[0]),y:Number(n.position[1])};
      if(n.type==='n8n-nodes-base.webhook'||n.type==='n8n-nodes-base.executeWorkflowTrigger'){node.type='start';node.data={};}
      if(n.type==='n8n-nodes-base.respondToWebhook'&&p.respondWith==='text'&&typeof p.responseBody==='string'&&!p.responseBody.startsWith('=')){node.type='message';node.data={text:p.responseBody};}
      if(n.type==='n8n-nodes-base.noOp'){node.type='variable';node.data={variable:'_continue',value:''};}
      if(n.disabled===true){node.type='unsupported';node.data={sourceType:value(n.type),disabledInSource:true};}
      if(node.type==='unsupported')warnings.push(node.label+': requer adaptação de '+value(n.type)+'.');
      if(n.disabled===true)warnings.push(node.label+': nó desabilitado na origem; revise antes de publicar.');
      if(n.credentials)warnings.push(node.label+': credenciais da origem não foram copiadas.');
      nodes.push(node);
    }
    const edges:FlowGraph['edges']=[];
    for(const [name,raw] of Object.entries(record(doc.connections))){
      const groups=record(raw);
      for(const [kind,ports] of Object.entries(groups)){
        if(kind!=='main'){warnings.push(name+': conexão '+kind+' ainda não suportada.');continue;}
        if(!Array.isArray(ports))throw new Error('Conexões n8n inválidas.');
        ports.forEach((items:unknown,index:number)=>{
          if(!Array.isArray(items))throw new Error('Saídas n8n inválidas.');
          for(const item of items){const edge=record(item);edges.push({id:'edge-'+edges.length,source:names.get(name)??name,target:names.get(value(edge.node))??value(edge.node),port:index===0?'next':'output-'+index});}
        });
      }
    }
    // Message-only response nodes must terminate explicitly in the native graph.
    for(const node of [...nodes])if(nodes.length<150&&node.type==='message'&&!edges.some(e=>e.source===node.id)){
      const endId='end-'+node.id;nodes.push({id:endId,type:'end',label:'Encerrar',position:{x:Math.min(100000,node.position.x+250),y:node.position.y},data:{}});edges.push({id:'end-edge-'+node.id,source:node.id,target:endId,port:'next'});
    }
    return {name:value(doc.name).slice(0,120)||'Workflow importado',graph:FlowGraphSchema.parse({nodes,edges}),warnings};
  }
  throw new Error('Formato não reconhecido. Importe JRC Flows ou um workflow n8n. Typebot exige conversão específica.');
}
