import {AutomationEntryConfigSchema,type FlowNode} from '@jrc/contracts';
type Props={node:FlowNode;editable:boolean;onChange:(data:FlowNode['data'])=>void};
export function EntryEditor({node,editable,onChange}:Props){
 const data=node.data,modern=data.entryConfigVersion===1;
 const keywords=data.keywords&&typeof data.keywords==='object'?data.keywords as Record<string,unknown>:undefined;
 const patch=(value:Record<string,unknown>)=>{if(editable)onChange({...data,...value});};
 const keyword=(value:Record<string,unknown>)=>patch({keywords:{...keywords,...value}});
 const parsed=modern?AutomationEntryConfigSchema.safeParse(data):undefined;
 return <fieldset disabled={!editable}>
  <p>Uma automação vinculada por caixa recebe mensagens. Conversas em andamento continuam na versão em que começaram.</p>
  {!modern?<button type="button" onClick={()=>patch({entryConfigVersion:1,trigger:'MESSAGE_RECEIVED',reentry:'ALWAYS'})}>Configurar condições de entrada</button>:<>
   <p>Gatilho: mensagem recebida. Outros eventos ainda não estão disponíveis neste executor.</p>
   <label>Reexecução<select value={String(data.reentry)} onChange={event=>patch({reentry:event.target.value})}>
    <option value="ALWAYS">Após terminar, permitir nova execução</option><option value="ONCE_PER_CONVERSATION">Uma vez por conversa nesta caixa</option>
   </select></label>
   <p>O limite considera o histórico deste Flow, inclusive versões anteriores. O Playground começa uma conversa sintética nova.</p>
   <label><input type="checkbox" checked={Boolean(keywords)} onChange={event=>{if(!editable)return;if(event.target.checked)keyword({mode:'CONTAINS',terms:[''],quantifier:'ANY',ignoreCase:true,ignoreAccents:true});else{const next={...data};delete next.keywords;onChange(next);}}}/>Filtrar primeira mensagem da execução</label>
   {keywords&&<>
    <label>Palavras-chave (uma por linha)<textarea rows={4} value={Array.isArray(keywords.terms)?keywords.terms.join('\n'):''} onChange={event=>keyword({terms:event.target.value.split('\n')})}/></label>
    <label>Correspondência<select value={String(keywords.mode)} onChange={event=>keyword({mode:event.target.value})}>
     <option value="EXACT">Igual a</option><option value="CONTAINS">Contém</option><option value="STARTS_WITH">Começa com</option><option value="ENDS_WITH">Termina com</option>
    </select></label>
    <label>Combinação<select value={String(keywords.quantifier)} onChange={event=>keyword({quantifier:event.target.value})}><option value="ANY">Qualquer palavra</option><option value="ALL">Todas as palavras</option></select></label>
    <label><input type="checkbox" checked={keywords.ignoreCase===true} onChange={event=>keyword({ignoreCase:event.target.checked})}/>Ignorar maiúsculas e minúsculas</label>
    <label><input type="checkbox" checked={keywords.ignoreAccents===true} onChange={event=>keyword({ignoreAccents:event.target.checked})}/>Ignorar acentos</label>
    <p>Essas condições iniciam execuções novas; respostas a uma captura em andamento não passam por esse filtro.</p>
   </>}
   {parsed&&!parsed.success&&<p role="alert">Revise as condições: selecione opções válidas e informe de 1 a 50 palavras-chave, até 200 caracteres por linha, sem linhas vazias.</p>}
  </>}
 </fieldset>;
}
