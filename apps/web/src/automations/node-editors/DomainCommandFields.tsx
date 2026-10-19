import type {FlowNode} from '@jrc/contracts';

type Props={data:FlowNode['data'];owners:Array<{id:number;name:string}>;onChange(data:FlowNode['data']):void};
function localDate(value:unknown){
 const date=new Date(String(value??''));
 if(!Number.isFinite(date.getTime()))return '';
 return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
}
export function DomainCommandFields({data,owners,onChange}:Props){
 const command=String(data.command??'create_lead');
 const due=data.dueAt as {kind?:string;value?:string;variable?:string}|undefined;
 const change=(values:Record<string,unknown>)=>onChange({...data,...values});
 return <>
  <p>Cria ou reutiliza o lead desta conversa. Tarefas e reuniões ficam vinculadas a ele. Nenhuma mensagem ou convite externo é enviado.</p>
  <label>Ação no CRM<select value={command} onChange={event=>{
   const base=Object.fromEntries(Object.entries(data).filter(([key])=>!['command','ownerId','title','dueAt'].includes(key)));
   onChange({...base,command:event.target.value,...(event.target.value==='create_lead'?{}:{ownerId:owners[0]?.id??0,title:'',dueAt:{kind:'LITERAL',value:''}})});
  }}><option value="create_lead">Criar ou reutilizar lead</option><option value="create_task">Criar tarefa</option><option value="create_meeting">Registrar reunião</option></select></label>
  {command!=='create_lead'&&<>
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
