import type {FlowGraph} from './flows.js';
import {AutomationHandoffConfigV1Schema,type AutomationHandoffConfigV1} from './automation-handoff-v1.js';
import {ScheduleNodeConfigSchema,type ScheduleNodeConfig} from './automation-schedule.js';

export const OIA_DEPARTMENTS=[
  {id:'sales',pt:'Comercial',en:'Sales',positions:2},
  {id:'operations-sp',pt:'Operacional São Paulo',en:'Operations Sao Paulo',positions:4},
  {id:'operations-poa',pt:'Operacional Porto Alegre',en:'Operations Porto Alegre',positions:4},
  {id:'finance',pt:'Financeiro',en:'Finance',positions:3},
] as const;
type Target={label:string;handoff:AutomationHandoffConfigV1};
export type OiaVisualReconstructionOptions={targets?:Record<string,Target>;schedule?:ScheduleNodeConfig};

/** Partial visual reconstruction. Default names, hours and retry policy are HML fixtures.
 * An unconfigured handoff stays a draft until the editor selects a real authorized catalog target.
 * Both languages share the same canonical handoff nodes; position does not imply unique person.
 */
export function oiaVisualReconstructionFlow(config:OiaVisualReconstructionOptions={}):FlowGraph{
  const schedule=ScheduleNodeConfigSchema.parse(config.schedule??{timezone:'America/Sao_Paulo',weekly:
    [1,2,3,4,5].map(day=>({day,start:'08:00',end:'18:00'}))});
  const nodes:FlowGraph['nodes']=[],edges:FlowGraph['edges']=[];
  const add=(id:string,type:string,label:string,data:Record<string,unknown>={},column=0,row=0)=>{
    nodes.push({id,type,label,position:{x:40+column*300,y:40+row*150},data});
  };
  const connect=(source:string,target:string,port='next')=>edges.push({id:`${source}:${port}`,source,target,port});
  const menu=(id:string,text:string,variable:string,options:{value:string;label:string}[],language:'pt'|'en'|'both',column:number,row:number)=>{
    add(id,'menu',text,{text,variable,options,menuConfigVersion:2,maxAttempts:3,timeoutSeconds:300,
      errorMessage:language==='pt'?'Opção inválida. Digite uma das opções.':language==='en'?'Invalid option. Enter one of the options.':'Opção inválida. Invalid option.'},column,row);
    connect(id,`limit-${language}`,'exhausted');connect(id,`timeout-${language}`,'timeout');
  };
  add('start','start','OIA — reconstrução visual parcial HML',{entryConfigVersion:1,trigger:'MESSAGE_RECEIVED',reentry:'ONCE_PER_CONVERSATION'});
  add('schedule','schedule','Expediente HML — confirmar horários',schedule,1);
  add('closed-notice','message','Aviso fora do expediente',{text:'Estamos fora do horário de atendimento. Sua solicitação será encaminhada para o próximo expediente. / We are outside business hours. Your request will be forwarded for the next business period.'},2,1);
  add('welcome','message','Boas-vindas únicas',{text:'Olá! Bem-vindo à OIA Global. / Hello! Welcome to OIA Global.'},3);
  menu('language','Selecione o idioma / Select your language','language_option',[{value:'1',label:'Português'},{value:'2',label:'English'}],'both',4,0);
  connect('start','schedule');connect('schedule','welcome','open');connect('schedule','closed-notice','closed');connect('closed-notice','welcome');connect('welcome','language');
  add('end','end','Encerrar sessão HML',{},12,20);
  for(const language of ['both','pt','en'] as const){
    add(`limit-${language}`,'message','Limite de tentativas HML',{text:language==='pt'?'Limite de tentativas atingido.':language==='en'?'Maximum attempts reached.':'Limite de tentativas atingido. / Maximum attempts reached.'},11,language==='both'?16:language==='pt'?17:18);
    add(`timeout-${language}`,'message','Prazo do menu HML',{text:language==='pt'?'Não recebemos sua resposta a tempo.':language==='en'?'We did not receive your reply in time.':'Não recebemos sua resposta a tempo. / We did not receive your reply in time.'},11,language==='both'?19:language==='pt'?20:21);
    connect(`limit-${language}`,'end');connect(`timeout-${language}`,'end');
  }
  for(const [li,language] of (['pt','en'] as const).entries()){
    const base=li*14;
    add(`language-${language}`,'variable',`Idioma: ${language}`,{variable:'language',value:language},5,base);
    connect('language',`language-${language}`,`option-${li+1}`);connect(`language-${language}`,`departments-${language}`);
    menu(`departments-${language}`,language==='pt'?'Selecione o departamento':'Select your department','department_option',OIA_DEPARTMENTS.map((department,i)=>({value:String(i+1),label:department[language]})),language,6,base);
    for(const [di,department] of OIA_DEPARTMENTS.entries()){
      const row=base+di*3,id=`${department.id}-${language}`;
      add(`department-${id}`,'variable',department[language],{variable:'department',value:department.id},7,row);
      connect(`departments-${language}`,`department-${id}`,`option-${di+1}`);connect(`department-${id}`,`attendants-${id}`);
      const positions=Array.from({length:department.positions},(_,i)=>{
        const position=`${department.id}-${i+1}`,target=config.targets?.[position];
        if(target&&(!target.label.trim()||target.label.length>120))throw Error('OIA_TARGET_LABEL_INVALID');
        return {value:String(i+1),label:target?.label??`HML ${department[language]} ${i+1}`};
      });
      menu(`attendants-${id}`,language==='pt'?'Selecione o atendente':'Select your attendant','attendant_option',[...positions,{value:String(department.positions+1),label:language==='pt'?'Voltar':'Return'}],language,8,row);
      connect(`attendants-${id}`,`departments-${language}`,`option-${department.positions+1}`);
      for(const [i,position] of positions.entries()){
        const key=`${department.id}-${i+1}`,announcement=`announce-${key}-${language}`;
        add(announcement,'message',language==='pt'?'Encaminhar atendimento':'Transfer to attendant',{text:language==='pt'?`Aguarde, vamos encaminhar seu atendimento para ${position.label}, do setor ${department.pt}.`:`Please wait, we will transfer your conversation to ${position.label}, ${department.en}.`},9,row+i/5);
        connect(`attendants-${id}`,announcement,`option-${i+1}`);connect(announcement,`selected-${key}`);
        if(li===0){
          add(`selected-${key}`,'variable',`Posição: ${key}`,{variable:'attendant_position',value:key},10,row+i/5);
          const target=config.targets?.[key];
          add(`handoff-${key}`,'handoff',`Destino nativo: ${key}`,target?AutomationHandoffConfigV1Schema.parse(target.handoff):{},11,row+i/5);
          connect(`selected-${key}`,`handoff-${key}`);
        }
      }
    }
  }
  return {nodes,edges};
}
