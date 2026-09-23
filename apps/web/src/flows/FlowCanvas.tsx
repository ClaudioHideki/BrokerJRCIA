import { useLayoutEffect, useRef, useState } from 'react';
import { AUTOMATION_NODE_CATALOG_V1, FLOW_NODE_CATALOG, automationNodePorts, type FlowGraph, type FlowNode } from '@jrc/contracts';

const portName=(port:string)=>port==='yes'?'Sim':port==='no'?'Não':port.startsWith('option-')?'Opção '+port.slice(7):'Continuar';
const ioTypes=['http','sql','code','ai-generate','ai-classify','ai-extract','ai-summarize','ai-agent'];
type CatalogItem={type:string;label:string;description:string;category?:string};
export function FlowCanvas({graph,onChange,editable,catalog=FLOW_NODE_CATALOG as readonly CatalogItem[]}:{graph:FlowGraph;onChange:(graph:FlowGraph)=>void;editable:boolean;catalog?:readonly CatalogItem[]}){
 const [selected,setSelected]=useState(graph.nodes[0]?.id??'');
 const [zoom,setZoom]=useState(1);
 const scrollRef=useRef<HTMLDivElement>(null);
 const graphBounds=()=>({x:60-Math.min(...graph.nodes.map(n=>n.position.x),0),y:80-Math.min(...graph.nodes.map(n=>n.position.y),0)});
 const [offset,setOffset]=useState(graphBounds);
 function fit(){
  const x=60-Math.min(...graph.nodes.map(n=>n.position.x)),y=80-Math.min(...graph.nodes.map(n=>n.position.y));
  const width=Math.max(400,...graph.nodes.map(n=>n.position.x+x+280));
  const height=Math.max(300,...graph.nodes.map(n=>n.position.y+y+360));
  const viewport=scrollRef.current;
  setOffset({x,y});setZoom(Math.min(1,(viewport?.clientWidth||800)/width,(viewport?.clientHeight||600)/height));
  if(viewport){viewport.scrollLeft=0;viewport.scrollTop=0;}
 }
 // Imported coordinates can be negative or far from the origin. The viewport must not mutate the saved graph.
 useLayoutEffect(()=>{fit();},[]);
 const [connecting,setConnecting]=useState<{source:string;port:string}|null>(null);
 const [search,setSearch]=useState('');
 const drag=useRef<{id:string;x:number;y:number;originX:number;originY:number}|null>(null);
 const node=graph.nodes.find(n=>n.id===selected);
 const patch=(value:Partial<FlowNode>)=>{if(node)onChange({...graph,nodes:graph.nodes.map(n=>n.id===node.id?{...n,...value}:n)});};
 const data=(key:string,value:string)=>{if(node)patch({data:{...node.data,[key]:value}});};
 const connect=(source:string,port:string,target:string)=>{
  const edges=graph.edges.filter(e=>!(e.source===source&&e.port===port));
  if(target)edges.push({id:crypto.randomUUID(),source,port,target});
  onChange({...graph,edges});setConnecting(null);
 };
 const ports=(current:FlowNode)=>catalog===AUTOMATION_NODE_CATALOG_V1?automationNodePorts(current):['delay','subflow'].includes(current.type)?['next']:automationNodePorts(current);
 const add=(type:string,position?:{x:number;y:number})=>{
  const definition=catalog.find(n=>n.type===type)!;
  const id=crypto.randomUUID();
  const defaults:Record<string,unknown>=type==='message'?{text:'Nova mensagem'}:type==='input'?{text:'Qual é sua resposta?',variable:'resposta'}:type==='menu'?{text:'Escolha uma opção:',variable:'menu.choice',options:[{value:'1',label:'Comercial'},{value:'2',label:'Suporte'}]}:type==='variable'?{variable:'variavel',value:''}:type==='condition'?{field:'message',operator:'equals',value:''}:type==='delay'?{seconds:60}:type==='subflow'?{automationId:'',version:1,timeoutMs:10000}:type==='http'?{method:'GET',url:'https://',credentialId:'',target:'http.result',timeoutMs:15000}:type==='sql'?{credentialId:'',query:'SELECT 1',parameters:[],target:'sql.result',timeoutMs:5000,maxRows:100}:type==='code'?{code:'return input;',input:{},target:'code.result'}:type.startsWith('ai-')?{credentialId:'',model:'',content:'{{message}}',target:'ai.result',tools:[],allowedTools:[]}:type.startsWith('data-')||['json-parse','json-stringify','expression'].includes(type)?{target:'resultado'}:{};
  onChange({...graph,nodes:[...graph.nodes,{id,type,label:definition.label,position:position??{x:80+(graph.nodes.length%4)*270,y:80+Math.floor(graph.nodes.length/4)*190},data:defaults}]});
  setSelected(id);
 };
 const width=Math.max(1200,...graph.nodes.map(n=>n.position.x+offset.x+300));
 const height=Math.max(650,...graph.nodes.map(n=>n.position.y+offset.y+360));
 return <div className="flows-builder">
  <aside className="flows-palette"><h3>Blocos</h3><p>Construa o caminho da conversa.</p><label>Buscar bloco<input aria-label="Buscar bloco" value={search} onChange={event=>setSearch(event.target.value)}/></label>
   {catalog.filter(item=>(item.label+' '+item.category).toLowerCase().includes(search.toLowerCase())).map(c=><button type="button" draggable={editable} onDragStart={event=>event.dataTransfer.setData('application/x-jrc-node',c.type)} key={c.type} disabled={!editable||graph.nodes.length>=150||(c.type==='start'&&graph.nodes.some(n=>n.type==='start'))} onClick={()=>add(c.type)} title={c.description}><span className={'flow-dot flow-dot--'+c.type}/><span>{c.label}{c.category&&<small>{c.category}</small>}</span></button>)}
   <small>Arraste os blocos. Clique em uma saída e depois no bloco de destino, ou use “Próximos passos”.</small>
  </aside>
  <section className="flows-canvas-wrap" aria-label="Canvas do flow">
   <div className="flows-canvas-tools"><button type="button" onClick={()=>setZoom(z=>Math.max(.05,z-.1))} aria-label="Diminuir zoom">−</button><span>{Math.round(zoom*100)}%</span><button type="button" onClick={()=>setZoom(z=>Math.min(1.5,z+.1))} aria-label="Aumentar zoom">+</button><button type="button" onClick={fit}>Visão geral</button>{connecting&&<button type="button" onClick={()=>setConnecting(null)}>Cancelar conexão</button>}</div>
   <div ref={scrollRef} className="flows-canvas-scroll" onDragOver={event=>{if(editable)event.preventDefault();}} onDrop={event=>{event.preventDefault();const type=event.dataTransfer.getData('application/x-jrc-node');if(!editable||!catalog.some(item=>item.type===type))return;const rect=event.currentTarget.getBoundingClientRect();add(type,{x:Math.max(-10000,Math.min(100000,(event.clientX-rect.left+event.currentTarget.scrollLeft)/zoom-offset.x)),y:Math.max(-10000,Math.min(100000,(event.clientY-rect.top+event.currentTarget.scrollTop)/zoom-offset.y))});}}>
    <div style={{width:width*zoom,height:height*zoom}}>
     <div className="flows-canvas" style={{width,height,transform:'scale('+zoom+')',transformOrigin:'top left'}}>
      <svg width={width} height={height} className="flows-wires" aria-label="Conexões entre blocos">
       {graph.edges.map(edge=>{
        const a=graph.nodes.find(n=>n.id===edge.source),b=graph.nodes.find(n=>n.id===edge.target);
        if(!a||!b)return null;
        const x=a.position.x+offset.x+220,y=a.position.y+offset.y+72+Math.max(0,ports(a).indexOf(edge.port))*25,bx=b.position.x+offset.x,by=b.position.y+offset.y+45;
        return <path key={edge.id} d={'M '+x+' '+y+' C '+(x+70)+' '+y+', '+(bx-70)+' '+by+', '+bx+' '+by}><title>{a.label+' → '+b.label}</title></path>;
       })}
      </svg>
      {graph.nodes.map(n=><div key={n.id} className={'flow-node '+(selected===n.id?'flow-node--selected ':'')+(!catalog.some(c=>c.type===n.type)?'flow-node--unsupported':'')} style={{left:n.position.x+offset.x,top:n.position.y+offset.y}}>
       <button type="button" className="flow-node-heading" aria-label={'Configurar '+n.label}
        onClick={()=>{if(connecting&&editable&&n.type!=='start'&&connecting.source!==n.id)connect(connecting.source,connecting.port,n.id);else setSelected(n.id);}}
        onPointerDown={event=>{if(!editable||connecting)return;drag.current={id:n.id,x:event.clientX,y:event.clientY,originX:n.position.x,originY:n.position.y};event.currentTarget.setPointerCapture(event.pointerId);}}
        onPointerMove={event=>{const d=drag.current;if(d?.id!==n.id||!editable)return;const x=Math.min(100000,Math.max(-10000,d.originX+(event.clientX-d.x)/zoom)),y=Math.min(100000,Math.max(-10000,d.originY+(event.clientY-d.y)/zoom));if(Math.abs(event.clientX-d.x)+Math.abs(event.clientY-d.y)>3)onChange({...graph,nodes:graph.nodes.map(item=>item.id===n.id?{...item,position:{x,y}}:item)});}}
        onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}} onKeyDown={event=>{if(!editable)return;const delta=event.shiftKey?20:5;if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();const dx=event.key==='ArrowLeft'?-delta:event.key==='ArrowRight'?delta:0,dy=event.key==='ArrowUp'?-delta:event.key==='ArrowDown'?delta:0;onChange({...graph,nodes:graph.nodes.map(item=>item.id===n.id?{...item,position:{x:Math.max(-10000,item.position.x+dx),y:Math.max(-10000,item.position.y+dy)}}:item)});}}}>
        <span className={'flow-dot flow-dot--'+n.type}/><strong>{n.label}</strong>
       </button>
       <small>{catalog.find(c=>c.type===n.type)?.label??'Requer adaptação'}</small>
       <div className="flow-node-ports">{ports(n).map(port=><button type="button" key={port} disabled={!editable} aria-label={'Conectar '+n.label+' '+portName(port)} onClick={()=>{setSelected(n.id);setConnecting({source:n.id,port});}}>{portName(port)}<span/></button>)}</div>
      </div>)}
     </div>
    </div>
   </div>
   <p className="flows-canvas-hint" aria-live="polite">{connecting?'Selecione o bloco de destino para esta saída.':'Conecte os blocos para definir a ordem de execução.'}</p>
  </section>
  <aside className="flows-inspector"><h3>Configurar bloco</h3>{node?<fieldset disabled={!editable}>
   <label>Nome do bloco<input value={node.label} maxLength={160} onChange={e=>patch({label:e.target.value})}/></label>
   {['message','input','menu'].includes(node.type)&&<label>{node.type==='message'?'Mensagem':node.type==='menu'?'Mensagem do menu':'Pergunta'}<textarea rows={5} maxLength={4096} value={String(node.data.text??'')} onChange={e=>data('text',e.target.value)}/></label>}
   {['input','variable','menu'].includes(node.type)&&<label>Variável<input value={String(node.data.variable??'')} maxLength={100} onChange={e=>data('variable',e.target.value)}/></label>}
   {node.type==='menu'&&<label>Opções, uma por linha<textarea rows={6} value={(Array.isArray(node.data.options)?node.data.options:[]).map(raw=>{const option=raw as {value?:unknown;label?:unknown};return String(option.value??'')+'|'+String(option.label??'');}).join('\n')} onChange={e=>patch({data:{...node.data,options:e.target.value.split(/\r?\n/).filter(Boolean).map(line=>{const [optionValue,...label]=line.split('|');return {value:(optionValue??'').trim(),label:label.join('|').trim()};})}})} /></label>}
   {node.type==='condition'&&<><label>Campo<input value={String(node.data.field??'message')} onChange={e=>data('field',e.target.value)}/></label><label>Comparação<select value={String(node.data.operator??'equals')} onChange={e=>data('operator',e.target.value)}><option value="equals">Igual a</option><option value="not_equals">Diferente de</option><option value="contains">Contém</option><option value="starts_with">Começa com</option><option value="present">Está preenchido</option></select></label></>}
   {['variable','condition'].includes(node.type)&&<label>Valor<input value={String(node.data.value??'')} maxLength={4096} onChange={e=>data('value',e.target.value)}/></label>}
   {node.type==='delay'&&<label>Segundos<input type="number" min="1" max="604800" value={String(node.data.seconds??60)} onChange={e=>data('seconds',e.target.value)}/></label>}
   {node.type==='subflow'&&<><label>ID da automação<input value={String(node.data.automationId??'')} onChange={e=>data('automationId',e.target.value)}/></label><label>Versão<input type="number" min="1" value={String(node.data.version??1)} onChange={e=>data('version',e.target.value)}/></label></>}
   {(ioTypes.includes(node.type)||node.type.startsWith('data-')||['json-parse','json-stringify','expression'].includes(node.type))&&<label>Variável de destino<input value={String(node.data.target??'')} onChange={e=>data('target',e.target.value)}/></label>}
   {ioTypes.includes(node.type)&&node.type!=='code'&&<label>ID da credencial<input value={String(node.data.credentialId??'')} onChange={e=>data('credentialId',e.target.value)} placeholder="UUID do cofre"/></label>}
   {node.type==='http'&&<><label>Método<select value={String(node.data.method??'GET')} onChange={e=>data('method',e.target.value)}>{['GET','POST','PUT','PATCH','DELETE'].map(method=><option key={method}>{method}</option>)}</select></label><label>URL HTTPS<input value={String(node.data.url??'')} onChange={e=>data('url',e.target.value)}/></label></>}
   {node.type==='sql'&&<label>Consulta somente leitura<textarea rows={6} value={String(node.data.query??'')} onChange={e=>data('query',e.target.value)}/></label>}
   {node.type==='code'&&<label>JavaScript isolado<textarea rows={8} value={String(node.data.code??'')} onChange={e=>data('code',e.target.value)}/></label>}
   {node.type.startsWith('ai-')&&<><label>Modelo<input value={String(node.data.model??'')} onChange={e=>data('model',e.target.value)}/></label><label>Conteúdo<textarea rows={6} value={String(node.data.content??'')} onChange={e=>data('content',e.target.value)}/></label></>}
   {node.type==='unsupported'&&<p role="note">{node.data.sourceType==='IMPORT_REVIEW_REQUIRED'?'Revise todos os campos, expressões, credenciais e caminhos importados. Depois remova este aviso, salve, valide e teste antes de publicar.':'Este bloco importado precisa ser substituído por um bloco JRC. O rascunho pode ser salvo; a publicação fica bloqueada até a adaptação.'}</p>}
   {node.type==='handoff'&&<p>Ao chegar aqui, o chatbot pausa para o atendente. Retome em “Conversas”.</p>}
   <h4>Próximos passos</h4>{ports(node).map(port=><label key={port}>{portName(port)}<select aria-label={'Destino '+portName(port)} value={graph.edges.find(e=>e.source===node.id&&e.port===port)?.target??''} onChange={e=>connect(node.id,port,e.target.value)}><option value="">Sem conexão</option>{graph.nodes.filter(n=>n.id!==node.id&&n.type!=='start').map(n=><option key={n.id} value={n.id}>{n.label}</option>)}</select></label>)}
   <p className="flows-help">Use {'{{contact.name}}'}, {'{{message}}'} ou a variável capturada, como {'{{nome}}'}.</p>
   {node.type!=='start'&&<button type="button" className="flows-delete" onClick={()=>{onChange({...graph,nodes:graph.nodes.filter(n=>n.id!==node.id),edges:graph.edges.filter(e=>e.source!==node.id&&e.target!==node.id)});setSelected(graph.nodes[0]?.id??'');}}>Remover bloco</button>}
  </fieldset>:<p>Selecione um bloco no canvas.</p>}</aside>
 </div>;
}
