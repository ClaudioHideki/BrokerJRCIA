import {useState} from 'react';
import type {BoxRoute,FlowNode} from '@jrc/contracts';
export function directoryMenuDefaults(routes:BoxRoute[]):Record<string,unknown>{return {directoryVersion:1,routeKey:routes.find(r=>r.mode==='AGENT')?.routeKey??'department',language:'pt',text:'Selecione o atendente',backLabel:'Voltar',errorMessage:'Opção inválida. Digite uma das opções.',maxAttempts:3,timeoutSeconds:300};}
export function DirectoryMenuEditor({node,routes,editable,onChange,onCreateRoute,canCreateRoute=true}:{node:FlowNode;routes:BoxRoute[];editable:boolean;onChange:(data:FlowNode['data'])=>void;onCreateRoute:(pt:string,en:string)=>void;canCreateRoute?:boolean}){
 const [pt,setPt]=useState(''),[en,setEn]=useState('');
 const change=(key:string,value:unknown)=>onChange({...node.data,[key]:value});
 return <fieldset disabled={!editable}><legend>Seleção de atendentes da caixa</legend>
  <p>Os nomes e destinos humanos são configurados no painel Flow por caixa. Este bloco define a conversa.</p>
  <label>Departamento do menu<select value={String(node.data.routeKey??'')} onChange={e=>change('routeKey',e.target.value)}><option value="">Selecione um departamento</option>{routes.filter(r=>r.mode==='AGENT').map(r=><option key={r.routeKey} value={r.routeKey}>{r.labels.pt} / {r.labels.en}</option>)}</select></label>
  <label>Idioma do menu de atendentes<select value={String(node.data.language??'pt')} onChange={e=>change('language',e.target.value)}><option value="pt">Português</option><option value="en">English</option></select></label>
  <label>Texto do menu de atendentes<textarea rows={4} maxLength={2048} value={String(node.data.text??'')} onChange={e=>change('text',e.target.value)}/></label>
  <label>Texto para voltar<input maxLength={120} value={String(node.data.backLabel??'Voltar')} onChange={e=>change('backLabel',e.target.value)}/></label>
  <label>Aviso de opção inválida<textarea rows={3} maxLength={512} value={String(node.data.errorMessage??'')} onChange={e=>change('errorMessage',e.target.value)}/></label>
  <label>Máximo de tentativas<input type="number" min={1} max={100} value={String(node.data.maxAttempts??3)} onChange={e=>change('maxAttempts',Number(e.target.value))}/></label>
  <label>Prazo de resposta em segundos<input type="number" min={1} max={604800} value={String(node.data.timeoutSeconds??'')} onChange={e=>{const next={...node.data};if(e.target.value==='')delete next.timeoutSeconds;else next.timeoutSeconds=Number(e.target.value);onChange(next);}}/></label>
  <p>Conecte as saídas Atendente escolhido, Voltar, Sem tentativas e, se houver prazo, Tempo limite.</p>
  <details><summary>Novo departamento do modelo</summary><label>Novo departamento em português<input value={pt} maxLength={120} onChange={e=>setPt(e.target.value)}/></label><label>Novo departamento em inglês<input value={en} maxLength={120} onChange={e=>setEn(e.target.value)}/></label>
   <button type="button" disabled={!canCreateRoute||routes.length>=20||!pt.trim()||!en.trim()} onClick={()=>{onCreateRoute(pt.trim(),en.trim());setPt('');setEn('');}}>Adicionar departamento ao modelo</button>
   {!canCreateRoute&&<p>Confira o bloco de início e as rotas declaradas antes de adicionar departamentos.</p>}
  </details>
 </fieldset>;
}
