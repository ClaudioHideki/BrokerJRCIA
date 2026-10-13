import {useState} from 'react';
import {HttpSimulationResponseSchema,type HttpSimulationResponse} from '@jrc/contracts';
export function HttpSimulationControl({nodeId,disabled,onResponse}:{nodeId:string;disabled:boolean;onResponse:(response:HttpSimulationResponse)=>void}){
 const [outcome,setOutcome]=useState<HttpSimulationResponse['outcome']>('success'),[status,setStatus]=useState(200),[body,setBody]=useState('');
 const synthetic=outcome==='timeout'||outcome==='unknown'?{type:'HTTP_RESPONSE',nodeId,outcome}:{type:'HTTP_RESPONSE',nodeId,outcome,status,body},parsed=HttpSimulationResponseSchema.safeParse(synthetic);
 return <div><p>Resposta fictícia somente neste teste. Nenhuma requisição HTTP, mensagem ou confirmação externa é produzida.</p><label>Resultado fictício<select disabled={disabled} value={outcome} onChange={event=>{const value=event.target.value as typeof outcome;setOutcome(value);setStatus(value==='success'?200:value==='client_error'?404:503);}}><option value="success">Sucesso</option><option value="client_error">Erro do cliente</option><option value="server_error">Erro do servidor</option><option value="timeout">Tempo limite</option><option value="unknown">Resultado desconhecido</option></select></label>
  {outcome!=='timeout'&&outcome!=='unknown'&&<><label>Status HTTP fictício<input disabled={disabled} type="number" value={status} onChange={event=>setStatus(Number(event.target.value))}/></label><label>Corpo da resposta fictícia<textarea disabled={disabled} value={body} onChange={event=>setBody(event.target.value)}/></label><small>Até 32 KiB em UTF-8; o corpo é texto e não precisa de schema.</small></>}
  {!parsed.success&&<p role="alert">Revise o status e o tamanho da resposta fictícia.</p>}<button type="button" disabled={disabled||!parsed.success} onClick={()=>{if(parsed.success)onResponse(parsed.data);}}>Usar resposta fictícia no teste</button>
 </div>;
}
