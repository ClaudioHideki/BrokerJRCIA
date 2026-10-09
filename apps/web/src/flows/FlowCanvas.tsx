import { useLayoutEffect, useRef, useState } from 'react';
import { AUTOMATION_NODE_CATALOG_V1, FLOW_NODE_CATALOG, automationNodePorts, type FlowGraph, type FlowNode } from '@jrc/contracts';
import { MenuEditor } from '../automations/node-editors/MenuEditor.js';
import { HandoffEditor } from '../automations/node-editors/HandoffEditor.js';
import type { ApiClient } from '../api/client.js';
import { InputEditor } from '../automations/node-editors/InputEditor.js';
import { DataReferencePicker } from '../automations/node-editors/DataReferencePicker.js';
import {DataNodeEditor} from '../automations/node-editors/DataNodeEditor.js';
import {isDataNodeType} from '@jrc/contracts';
import { ScheduleEditor } from '../automations/node-editors/ScheduleEditor.js';

const portName=(port:string)=>port==='success'?'Sucesso':port==='error'?'Erro':port==='yes'?'Sim':port==='no'?'Não':port==='open'?'Dentro do horário':port==='closed'?'Fora do horário':port.startsWith('option-')?'Opção '+port.slice(7):'Continuar';
const ioTypes=['http','sql','code','ai-generate','ai-classify','ai-extract','ai-summarize','ai-agent'];
type CatalogItem={type:string;label:string;description:string;category?:string};
export function FlowCanvas({graph,onChange,editable,catalog=FLOW_NODE_CATALOG as readonly CatalogItem[],errorNodeIds=[],handoffContext}:{graph:FlowGraph;onChange:(graph:FlowGraph)=>void;editable:boolean;catalog?:readonly CatalogItem[];errorNodeIds?:readonly string[];handoffContext?:{client:ApiClient;organizationId:string}|undefined}){
 const [selected,setSelected]=useState(graph.nodes[0]?.id??'');
 const [historyVersion,setHistoryVersion]=useState(0);
 const history=useRef<{items:FlowGraph[];index:number}>({items:[graph],index:0});
 const expectedGraph=useRef<FlowGraph|null>(null);
 const currentGraph=useRef(graph);currentGraph.current=graph;
 useLayoutEffect(()=>{if(graph===expectedGraph.current){expectedGraph.current=null;return;}if(graph!==history.current.items[history.current.index]&&JSON.stringify(graph)!==JSON.stringify(history.current.items[history.current.index])){history.current={items:[graph],index:0};setHistoryVersion(v=>v+1);}},[graph]);
 function emitGraph(next:FlowGraph,coalesce=false){const state=history.current;if(JSON.stringify(next)===JSON.stringify(state.items[state.index]))return;if(coalesce)state.items[state.index]=next;else{state.items=[...state.items.slice(0,state.index+1),next].slice(-100);state.index=state.items.length-1;}expectedGraph.current=next;setHistoryVersion(v=>v+1);onChange(next);}
 function stepHistory(direction:-1|1){const state=history.current,next=state.index+direction;if(!editable||next<0||next>=state.items.length)return;state.index=next;expectedGraph.current=state.items[next]!;setHistoryVersion(v=>v+1);onChange(state.items[next]!);}
 const [zoom,setZoom]=useState(1);
 const [pan,setPan]=useState({x:0,y:0});
 const view=useRef({zoom:1,pan:{x:0,y:0}});
 const panning=useRef<{x:number;y:number;origin:{x:number;y:number}}|null>(null);
 const updateView=(nextZoom:number,nextPan:{x:number;y:number})=>{view.current={zoom:nextZoom,pan:nextPan};setZoom(nextZoom);setPan(nextPan);};
 const scrollRef=useRef<HTMLDivElement>(null);
 const graphBounds=()=>({x:60-Math.min(...graph.nodes.map(n=>n.position.x),0),y:80-Math.min(...graph.nodes.map(n=>n.position.y),0)});
 const [offset,setOffset]=useState(graphBounds);
 function fit(initial=false){
  const x=60-Math.min(...graph.nodes.map(n=>n.position.x),0),y=80-Math.min(...graph.nodes.map(n=>n.position.y),0);
  const width=Math.max(400,...graph.nodes.map(n=>n.position.x+x+280));
  const height=Math.max(300,...graph.nodes.map(n=>n.position.y+y+360));
  const viewport=scrollRef.current;
  const fitted=Math.max(.02,Math.min(1,(viewport?.clientWidth||800)/width,(viewport?.clientHeight||600)/height));
  const nextZoom=initial?Math.max(.25,fitted):fitted;
  const first=graph.nodes[0];
  setOffset({x,y});updateView(nextZoom,initial&&fitted<.25&&first?{x:(viewport?.clientWidth||800)/2-(first.position.x+x+110)*nextZoom,y:(viewport?.clientHeight||600)/2-(first.position.y+y+70)*nextZoom}:{x:0,y:0});
  if(viewport){viewport.scrollLeft=0;viewport.scrollTop=0;}
 }
 // Imported coordinates can be negative or far from the origin. The viewport must not mutate the saved graph.
 useLayoutEffect(()=>{fit(true);},[]);
 function zoomAt(next:number,x:number,y:number){
  const current=view.current;const bounded=Math.max(.02,Math.min(2,next));const ratio=bounded/current.zoom;
  updateView(bounded,{x:x-(x-current.pan.x)*ratio,y:y-(y-current.pan.y)*ratio});
 }
 function toolbarZoom(factor:number){const viewport=scrollRef.current;zoomAt(view.current.zoom*factor,(viewport?.clientWidth||800)/2,(viewport?.clientHeight||600)/2);}
 function focusNode(id:string){const current=graph.nodes.find(n=>n.id===id);if(!current)return;setSelected(id);const viewport=scrollRef.current;updateView(1,{x:(viewport?.clientWidth||800)/2-(current.position.x+offset.x+110),y:(viewport?.clientHeight||600)/2-(current.position.y+offset.y+70)});}
 function centerSelection(){focusNode(graph.nodes.find(n=>n.id===selected)?.id??graph.nodes[0]?.id??'');}
 function duplicate(){if(!editable||!node||node.type==='start'||graph.nodes.length>=150)return;const id=crypto.randomUUID();emitGraph({...graph,nodes:[...graph.nodes,{...node,id,label:`${node.label} (cópia)`,position:{x:node.position.x+40,y:node.position.y+40},data:{...node.data}}]});setSelected(id);}
 useLayoutEffect(()=>{
  const viewport=scrollRef.current;if(!viewport)return;
  const wheel=(event:WheelEvent)=>{event.preventDefault();const rect=viewport.getBoundingClientRect();const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?viewport.clientHeight||600:1);zoomAt(view.current.zoom*Math.exp(-Math.max(-300,Math.min(300,delta))*.002),event.clientX-rect.left,event.clientY-rect.top);};
  viewport.addEventListener('wheel',wheel,{passive:false});return()=>viewport.removeEventListener('wheel',wheel);
 },[]);
 const [connecting,setConnecting]=useState<{source:string;port:string}|null>(null);
 const [search,setSearch]=useState('');
 const drag=useRef<{id:string;x:number;y:number;originX:number;originY:number;moved:boolean}|null>(null);
 const node=graph.nodes.find(n=>n.id===selected);
 const patch=(value:Partial<FlowNode>)=>{if(node)emitGraph({...graph,nodes:graph.nodes.map(n=>n.id===node.id?{...n,...value}:n)});};
 const data=(key:string,value:string)=>{if(node)patch({data:{...node.data,[key]:value}});};
 const connect=(source:string,port:string,target:string)=>{
  const edges=graph.edges.filter(e=>!(e.source===source&&e.port===port));
  if(target)edges.push({id:crypto.randomUUID(),source,port,target});
  emitGraph({...graph,edges});setConnecting(null);
 };
 const ports=(current:FlowNode)=>catalog===AUTOMATION_NODE_CATALOG_V1?automationNodePorts(current):['delay','subflow'].includes(current.type)?['next']:automationNodePorts(current);
 const add=(type:string,position?:{x:number;y:number})=>{
  const definition=catalog.find(n=>n.type===type)!;
  const id=crypto.randomUUID();
  const defaults:Record<string,unknown>=type==='message'?{text:'Nova mensagem'}:type==='input'?{text:'Qual é sua resposta?',variable:'resposta'}:type==='menu'?{text:'Escolha uma opção:',variable:'menu.choice',options:[{value:'1',label:'Comercial'},{value:'2',label:'Suporte'}]}:type==='variable'?{variable:'variavel',value:''}:type==='condition'?{field:'message',operator:'equals',value:''}:type==='handoff'?{handoffVersion:1}:type==='delay'?{seconds:60}:type==='subflow'?{automationId:'',version:1,timeoutMs:10000}:type==='http'?{method:'GET',url:'https://',credentialId:'',target:'http.result',timeoutMs:15000}:type==='sql'?{credentialId:'',query:'SELECT 1',parameters:[],target:'sql.result',timeoutMs:5000,maxRows:100}:type==='code'?{code:'return input;',input:{},target:'code.result'}:type.startsWith('ai-')?{credentialId:'',model:'',content:'{{message}}',target:'ai.result',tools:[],allowedTools:[]}:isDataNodeType(type)?{configVersion:2,target:'resultado',errorVariable:'erro',...(type==='data-set'?{valueSource:{kind:'LITERAL',value:''}}:type==='data-merge'?{sources:['','']}:type==='data-pick'?{source:'',keys:['']}:type==='data-map'?{source:'',field:''}:type==='data-filter'?{source:'',field:'',operator:'equals',valueSource:{kind:'LITERAL',value:''}}:type==='expression'?{source:'',operation:'REFERENCE'}:{source:''})}:{};
  if(type==='schedule')Object.assign(defaults,{timezone:'America/Sao_Paulo',weekly:[{day:1,start:'09:00',end:'18:00'}],exceptions:[]});
  emitGraph({...graph,nodes:[...graph.nodes,{id,type,label:definition.label,position:position??{x:80+(graph.nodes.length%4)*270,y:80+Math.floor(graph.nodes.length/4)*190},data:defaults}]});
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
   <div className="flows-canvas-tools"><button type="button" onClick={()=>toolbarZoom(1/1.2)} aria-label="Diminuir zoom">−</button><span>{Math.round(zoom*100)}%</span><button type="button" onClick={()=>toolbarZoom(1.2)} aria-label="Aumentar zoom">+</button><button type="button" onClick={()=>fit()}>Visão geral</button><button type="button" aria-label="Centralizar seleção em 100%" onClick={centerSelection}>100%</button><button type="button" onClick={()=>focusNode(graph.nodes.find(n=>n.type==='start')?.id??'')} aria-label="Localizar início">Início</button><button type="button" disabled={!errorNodeIds.some(id=>graph.nodes.some(n=>n.id===id))} onClick={()=>focusNode(errorNodeIds.find(id=>graph.nodes.some(n=>n.id===id))??'')} aria-label="Localizar bloco com erro">Erro</button><button type="button" disabled={!editable||history.current.index===0} onClick={()=>stepHistory(-1)} aria-label="Desfazer">↶</button><button type="button" disabled={!editable||history.current.index>=history.current.items.length-1} onClick={()=>stepHistory(1)} aria-label="Refazer">↷</button><button type="button" disabled={!editable||!node||node.type==='start'||graph.nodes.length>=150} onClick={duplicate} aria-label="Duplicar bloco selecionado">Duplicar</button>{connecting&&<button type="button" onClick={()=>setConnecting(null)}>Cancelar conexão</button>}</div>
   <div ref={scrollRef} className="flows-canvas-scroll" style={{overflow:'hidden',touchAction:'none',cursor:'grab'}}
    onPointerDown={event=>{if(event.button!==0||(event.target as Element).closest('.flow-node'))return;event.preventDefault();panning.current={x:event.clientX,y:event.clientY,origin:view.current.pan};event.currentTarget.setPointerCapture(event.pointerId);}}
    onPointerMove={event=>{const active=panning.current;if(active)updateView(view.current.zoom,{x:active.origin.x+event.clientX-active.x,y:active.origin.y+event.clientY-active.y});}}
    onPointerUp={event=>{if(panning.current){panning.current=null;event.currentTarget.releasePointerCapture(event.pointerId);}}}
    onPointerCancel={()=>{panning.current=null;}} onLostPointerCapture={()=>{panning.current=null;}}
    onDragOver={event=>{if(editable)event.preventDefault();}} onDrop={event=>{event.preventDefault();const type=event.dataTransfer.getData('application/x-jrc-node');if(!editable||!catalog.some(item=>item.type===type))return;const rect=event.currentTarget.getBoundingClientRect();add(type,{x:Math.max(-10000,Math.min(100000,(event.clientX-rect.left-pan.x)/zoom-offset.x)),y:Math.max(-10000,Math.min(100000,(event.clientY-rect.top-pan.y)/zoom-offset.y))});}}>
    <div style={{width:width*zoom,height:height*zoom}}>
     <div className="flows-canvas" style={{width,height,transform:'translate('+pan.x+'px, '+pan.y+'px) scale('+zoom+')',transformOrigin:'top left'}}>
      <svg width={width} height={height} className="flows-wires" aria-label="Conexões entre blocos">
       {graph.edges.map(edge=>{
        const a=graph.nodes.find(n=>n.id===edge.source),b=graph.nodes.find(n=>n.id===edge.target);
        if(!a||!b)return null;
        const x=a.position.x+offset.x+220,y=a.position.y+offset.y+72+Math.max(0,ports(a).indexOf(edge.port))*25,bx=b.position.x+offset.x,by=b.position.y+offset.y+45;
        return <path key={edge.id} d={'M '+x+' '+y+' C '+(x+70)+' '+y+', '+(bx-70)+' '+by+', '+bx+' '+by}><title>{a.label+' → '+b.label}</title></path>;
       })}
      </svg>
      {graph.nodes.map(n=><div key={n.id} className={'flow-node '+(selected===n.id?'flow-node--selected ':'')+(errorNodeIds.includes(n.id)?'flow-node--error ':'')+(!catalog.some(c=>c.type===n.type)?'flow-node--unsupported':'')} style={{left:n.position.x+offset.x,top:n.position.y+offset.y}}>
       <button type="button" className="flow-node-heading" aria-label={'Configurar '+n.label}
        onClick={()=>{if(connecting&&editable&&n.type!=='start'&&connecting.source!==n.id)connect(connecting.source,connecting.port,n.id);else setSelected(n.id);}}
        onPointerDown={event=>{if(event.button!==0||!editable||connecting)return;drag.current={id:n.id,x:event.clientX,y:event.clientY,originX:n.position.x,originY:n.position.y,moved:false};event.currentTarget.setPointerCapture(event.pointerId);}}
        onPointerMove={event=>{const d=drag.current;if(d?.id!==n.id||!editable)return;const x=Math.min(100000,Math.max(-10000,d.originX+(event.clientX-d.x)/zoom)),y=Math.min(100000,Math.max(-10000,d.originY+(event.clientY-d.y)/zoom));if(Math.abs(event.clientX-d.x)+Math.abs(event.clientY-d.y)>3){emitGraph({...currentGraph.current,nodes:currentGraph.current.nodes.map(item=>item.id===n.id?{...item,position:{x,y}}:item)},d.moved);d.moved=true;}}}
        onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}} onKeyDown={event=>{if(!editable)return;const delta=event.shiftKey?20:5;if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();const dx=event.key==='ArrowLeft'?-delta:event.key==='ArrowRight'?delta:0,dy=event.key==='ArrowUp'?-delta:event.key==='ArrowDown'?delta:0;emitGraph({...graph,nodes:graph.nodes.map(item=>item.id===n.id?{...item,position:{x:Math.max(-10000,item.position.x+dx),y:Math.max(-10000,item.position.y+dy)}}:item)});}}}>
        <span className={'flow-dot flow-dot--'+n.type}/><strong>{n.label}</strong>
       </button>
       <small>{catalog.find(c=>c.type===n.type)?.label??'Requer adaptação'}</small>
       <div className="flow-node-ports">{ports(n).map(port=><button type="button" key={port} disabled={!editable} aria-label={'Conectar '+n.label+' '+portName(port)} onClick={()=>{setSelected(n.id);setConnecting({source:n.id,port});}}>{portName(port)}<span/></button>)}</div>
      </div>)}
     </div>
    </div>
   </div>
   <p className="flows-canvas-hint" aria-live="polite">{connecting?'Selecione o bloco de destino para esta saída.':'Arraste o fundo para navegar e use a roda do mouse para zoom. Use 100% para centralizar o bloco selecionado.'}</p>
  </section>
  <aside className="flows-inspector"><h3>Configurar bloco</h3>{node?<fieldset disabled={!editable}>
   <label>Nome do bloco<input value={node.label} maxLength={160} onChange={e=>patch({label:e.target.value})}/></label>
   {['message','menu'].includes(node.type)&&<label>{node.type==='message'?'Mensagem':'Mensagem do menu'}<textarea rows={5} maxLength={4096} value={String(node.data.text??'')} onChange={e=>data('text',e.target.value)}/></label>}
   {['variable','menu'].includes(node.type)&&<label>Variável<input value={String(node.data.variable??'')} maxLength={100} onChange={e=>data('variable',e.target.value)}/></label>}
   {node.type==='input'&&<InputEditor node={node} editable={editable} onChange={next=>patch({data:next})}/>}
   {node.type==='menu'&&<MenuEditor node={node} edges={graph.edges} editable={editable} onChange={(nextData,edges)=>emitGraph({...graph,nodes:graph.nodes.map(current=>current.id===node.id?{...current,data:nextData}:current),edges})}/>}
   {node.type==='condition'&&<><DataReferencePicker key={node.id} nodes={graph.nodes} value={String(node.data.field??'message')} editable={editable} onChange={value=>data('field',value)}/><label>Comparação<select value={String(node.data.operator??'equals')} onChange={e=>data('operator',e.target.value)}><option value="equals">Igual a</option><option value="not_equals">Diferente de</option><option value="contains">Contém</option><option value="starts_with">Começa com</option><option value="present">Está preenchido</option></select></label></>}
   {(node.type==='variable'||node.type==='condition'&&node.data.operator!=='present')&&<label>Valor<input value={String(node.data.value??'')} maxLength={4096} onChange={e=>data('value',e.target.value)}/></label>}
   {node.type==='delay'&&<label>Segundos<input type="number" min="1" max="604800" value={String(node.data.seconds??60)} onChange={e=>data('seconds',e.target.value)}/></label>}
   {node.type==='schedule'&&<ScheduleEditor data={node.data} editable={editable} onChange={next=>patch({data:next})}/>}
   {node.type==='subflow'&&<><label>ID da automação<input value={String(node.data.automationId??'')} onChange={e=>data('automationId',e.target.value)}/></label><label>Versão<input type="number" min="1" value={String(node.data.version??1)} onChange={e=>data('version',e.target.value)}/></label></>}
   {isDataNodeType(node.type)&&<DataNodeEditor key={node.id} node={node} nodes={graph.nodes} editable={editable} onChange={next=>patch({data:next})}/>}
   {ioTypes.includes(node.type)&&<label>Variável de destino<input value={String(node.data.target??'')} onChange={e=>data('target',e.target.value)}/></label>}
   {ioTypes.includes(node.type)&&node.type!=='code'&&<label>ID da credencial<input value={String(node.data.credentialId??'')} onChange={e=>data('credentialId',e.target.value)} placeholder="UUID do cofre"/></label>}
   {node.type==='http'&&<><label>Método<select value={String(node.data.method??'GET')} onChange={e=>data('method',e.target.value)}>{['GET','POST','PUT','PATCH','DELETE'].map(method=><option key={method}>{method}</option>)}</select></label><label>URL HTTPS<input value={String(node.data.url??'')} onChange={e=>data('url',e.target.value)}/></label></>}
   {node.type==='sql'&&<label>Consulta somente leitura<textarea rows={6} value={String(node.data.query??'')} onChange={e=>data('query',e.target.value)}/></label>}
   {node.type==='code'&&<label>JavaScript isolado<textarea rows={8} value={String(node.data.code??'')} onChange={e=>data('code',e.target.value)}/></label>}
   {node.type.startsWith('ai-')&&<><label>Modelo<input value={String(node.data.model??'')} onChange={e=>data('model',e.target.value)}/></label><label>Conteúdo<textarea rows={6} value={String(node.data.content??'')} onChange={e=>data('content',e.target.value)}/></label></>}
   {node.type==='unsupported'&&<p role="note">{node.data.sourceType==='IMPORT_REVIEW_REQUIRED'?'Revise todos os campos, expressões, credenciais e caminhos importados. Depois remova este aviso, salve, valide e teste antes de publicar.':'Este bloco importado precisa ser substituído por um bloco JRC. O rascunho pode ser salvo; a publicação fica bloqueada até a adaptação.'}</p>}
   {node.type==='handoff'&&(handoffContext?<HandoffEditor key={handoffContext.organizationId+':'+node.id} node={node} editable={editable} client={handoffContext.client} organizationId={handoffContext.organizationId} onChange={next=>patch({data:next})}/>:<p>Configure o destino humano no editor de Automações para obter uma transferência confirmada.</p>)}
   <h4>Próximos passos</h4>{ports(node).map(port=><label key={port}>{portName(port)}<select aria-label={'Destino '+portName(port)} value={graph.edges.find(e=>e.source===node.id&&e.port===port)?.target??''} onChange={e=>connect(node.id,port,e.target.value)}><option value="">Sem conexão</option>{graph.nodes.filter(n=>n.id!==node.id&&n.type!=='start').map(n=><option key={n.id} value={n.id}>{n.label}</option>)}</select></label>)}
   <p className="flows-help">Use {'{{message}}'} ou uma variável definida no fluxo, como {'{{nome}}'}.</p>
   {node.type!=='start'&&<button type="button" className="flows-delete" onClick={()=>{emitGraph({...graph,nodes:graph.nodes.filter(n=>n.id!==node.id),edges:graph.edges.filter(e=>e.source!==node.id&&e.target!==node.id)});setSelected(graph.nodes[0]?.id??'');}}>Remover bloco</button>}
  </fieldset>:<p>Selecione um bloco no canvas.</p>}</aside>
 </div>;
}
