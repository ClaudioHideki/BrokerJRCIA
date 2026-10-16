import type {FlowGraph} from './flows.js';

/** A portable draft: the tenant must choose each real destination in the editor. */
export function operatorReceptionFlow():FlowGraph{
 const routes=[
  {id:'comercial',label:'Comercial',prompt:'Conte qual produto ou serviço você procura.'},
  {id:'suporte',label:'Suporte / HELP',prompt:'Descreva o problema, o serviço ou linha afetada e os testes que já realizou.'},
  {id:'financeiro',label:'Financeiro',prompt:'Conte sua solicitação financeira. Nossa equipe dará continuidade ao atendimento.'},
  {id:'trabalhe-conosco',label:'Trabalhe conosco',prompt:'Conte como podemos ajudar com sua candidatura.'},
  {id:'privacidade',label:'Privacidade',prompt:'Descreva sua solicitação sobre privacidade para encaminharmos ao responsável.'},
  {id:'jrc-conversas',label:'JRC Conversas',prompt:'Você procura informações comerciais ou suporte ao JRC Conversas? Conte sua necessidade.'},
 ];
 const nodes:FlowGraph['nodes']=[
  {id:'start',type:'start',label:'Mensagem recebida',position:{x:40,y:320},data:{}},
  {id:'welcome',type:'message',label:'Recepção / Jade',position:{x:300,y:320},data:{text:'Olá! Como podemos ajudar? Escolha abaixo o assunto do atendimento.'}},
  {id:'menu',type:'menu',label:'Direcionar atendimento',position:{x:560,y:320},data:{text:'Digite o número da opção.',variable:'department',
   options:routes.map((route,index)=>({value:String(index+1),label:route.label,route:route.id}))}},
  {id:'timeout',type:'message',label:'Resposta não recebida',position:{x:1080,y:1100},data:{text:'Não recebemos sua resposta a tempo. Envie uma nova mensagem quando quiser continuar.'}},
  {id:'end',type:'end',label:'Encerrar sessão',position:{x:1340,y:1100},data:{}},
 ];
 const edges:FlowGraph['edges']=[
  {id:'start-welcome',source:'start',target:'welcome',port:'next'},
  {id:'welcome-menu',source:'welcome',target:'menu',port:'next'},
  {id:'timeout-end',source:'timeout',target:'end',port:'next'},
 ];
 for(const [index,route] of routes.entries()){
  const capture=`capture-${route.id}`,handoff=`handoff-${route.id}`,y=40+index*160;
  nodes.push({id:capture,type:'input',label:`Solicitação: ${route.label}`,position:{x:820,y},
   data:{inputConfigVersion:1,variable:`request.${route.id.replaceAll('-','_')}`,text:route.prompt,timeoutSeconds:900}},
  {id:handoff,type:'handoff',label:`Escolher destino: ${route.label}`,position:{x:1080,y},data:{}});
  edges.push({id:`menu-${route.id}`,source:'menu',target:capture,port:`option-${index+1}`},
   {id:`capture-${route.id}-next`,source:capture,target:handoff,port:'next'},
   {id:`capture-${route.id}-timeout`,source:capture,target:'timeout',port:'timeout'});
 }
 return {nodes,edges};
}
