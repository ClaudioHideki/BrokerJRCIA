import type {FlowNode} from '@jrc/contracts';

type Props={data:FlowNode['data'];owners:Array<{id:number;name:string}>;commands?:string[]|undefined;onChange(data:FlowNode['data']):void};
const labels:Record<string,string>={create_lead:'Criar ou reutilizar lead',create_task:'Criar tarefa',create_meeting:'Registrar reunião',
 service_desk_intake:'Registrar demanda no Service Desk',service_desk_status:'Consultar entrega ao GLPI'};
function localDate(value:unknown){
 const date=new Date(String(value??''));
 if(!Number.isFinite(date.getTime()))return '';
 return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
}
export function DomainCommandFields({data,owners,commands=['create_lead','create_task','create_meeting'],onChange}:Props){
 const command=String(data.command??'create_lead');
 const due=data.dueAt as {kind?:string;value?:string;variable?:string}|undefined;
 const change=(values:Record<string,unknown>)=>onChange({...data,...values});
 return <>
  {command.startsWith('service_desk_')?<p>Registra a triagem ou consulta seu resultado. O número do GLPI só está disponível após a confirmação da criação.</p>
   :<p>Cria ou reutiliza o lead desta conversa. Tarefas e reuniões ficam vinculadas a ele. Nenhuma mensagem ou convite externo é enviado.</p>}
  <label>Ação no JRC<select value={command} onChange={event=>{
   const base=Object.fromEntries(Object.entries(data).filter(([key])=>!['command','ownerId','title','dueAt','configurationId','configurationRevision','phase','input'].includes(key)));
   const next=event.target.value;
   const specific=next==='service_desk_intake'?{configurationId:0,configurationRevision:1,phase:'qualified',input:{system:'',location:'',reason:'',subject:'',identifier:'',email:'',description:''}}
    :next==='create_task'||next==='create_meeting'?{ownerId:owners[0]?.id??0,title:'',dueAt:{kind:'LITERAL',value:''}}:{};
   onChange({...base,command:next,...specific});
  }}>{!commands.includes(command)&&<option value={command}>Ação salva indisponível</option>}
   {commands.map(value=><option key={value} value={value}>{labels[value]}</option>)}</select></label>
  {command==='service_desk_intake'&&<>
   <label>Configuração de atendimento<input type="number" min={1} value={Number(data.configurationId??0)} onChange={event=>change({configurationId:Number(event.target.value)})}/></label>
   <label>Revisão da configuração<input type="number" min={1} value={Number(data.configurationRevision??1)} onChange={event=>change({configurationRevision:Number(event.target.value)})}/></label>
   <label>Momento da triagem<select value={String(data.phase??'qualified')} onChange={event=>change({phase:event.target.value})}>
    <option value="qualified">Dados conferidos</option><option value="handoff">Solicitou atendente</option></select></label>
   {Object.entries({system:'Sistema',location:'Localidade',reason:'Motivo',subject:'Assunto',profile:'Perfil declarado',severity:'Criticidade declarada (opcional)',
    impact:'Impacto informado',urgency:'Urgência informada',
    identifier:'CPF ou CNPJ',email:'E-mail informado',description:'Descrição da demanda'}).map(([key,label])=>{
     const input=(data.input??{}) as Record<string,unknown>;
     return <label key={key}>{label}<input value={String(input[key]??'')} onChange={event=>{
      const next={...input};if(event.target.value)next[key]=event.target.value;else delete next[key];change({input:next});
     }}/></label>;
   })}
  </>}
  {(command==='create_task'||command==='create_meeting')&&<>
   <label>Responsável<select value={String(data.ownerId??'')} onChange={event=>change({ownerId:Number(event.target.value)})}>
    <option value="">Selecione pelo nome</option>{owners.map(owner=><option key={owner.id} value={owner.id}>{owner.name}</option>)}
   </select></label>
   <label>Título da tarefa ou reunião<input maxLength={200} value={String(data.title??'')} onChange={event=>change({title:event.target.value})}/></label>
   <label>Data e hora<select value={due?.kind??'LITERAL'} onChange={event=>change({dueAt:event.target.value==='VARIABLE'?{kind:'VARIABLE',variable:''}:{kind:'LITERAL',value:''}})}>
    <option value="LITERAL">Escolher data e hora</option><option value="VARIABLE">Usar variável do fluxo</option>
   </select></label>
   {due?.kind==='VARIABLE'?<label>Variável com data e fuso<input maxLength={100} value={due.variable??''} onChange={event=>change({dueAt:{kind:'VARIABLE',variable:event.target.value}})}/></label>
    :<label>Quando<input type="datetime-local" value={localDate(due?.value)} onChange={event=>{
     const date=new Date(event.target.value);change({dueAt:{kind:'LITERAL',value:Number.isFinite(date.getTime())?date.toISOString():''}});
    }}/></label>}
   <p>A data escolhida usa o fuso deste navegador. Variáveis devem incluir o fuso. Uma reunião registra o horário no CRM; disponibilidade de serviços e convites externos são operações separadas.</p>
  </>}
 </>;
}
