import { useRef, useState } from 'react';
import { FLOW_NODE_CATALOG, flowPorts, type FlowGraph, type FlowNode } from '@jrc/contracts';

const portName=(port:string)=>port==='yes'?'Sim':port==='no'?'Não':'Continuar';
export function FlowCanvas({graph,onChange,editable}:{graph:FlowGraph;onChange:(graph:FlowGraph)=>void;editable:boolean}){
 const [selected,setSelected]=useState(graph.nodes[0]?.id??'');
 const [zoom,setZoom]=useState(1);
 const [connecting,setConnecting]=useState<{source:string;port:string}|null>(null);
 const drag=useRef<{id:string;x:number;y:number;originX:number;originY:number}|null>(null);
 const node=graph.nodes.find(n=>n.id===selected);
 const patch=(value:Partial<FlowNode>)=>{if(node)onChange({...graph,nodes:graph.nodes.map(n=>n.id===node.id?{...n,...value}:n)});};
 const data=(key:string,value:string)=>{if(node)patch({data:{...node.data,[key]:value}});};
 const connect=(source:string,port:string,target:string)=>{
  const edges=graph.edges.filter(e=>!(e.source===source&&e.port===port));
  if(target)edges.push({id:crypto.randomUUID(),source,port,target});
  onChange({...graph,edges});setConnecting(null);
 };
 const add=(type:string)=>{
  const definition=FLOW_NODE_CATALOG.find(n=>n.type===type)!;
  const id=crypto.randomUUID();
  const defaults:Record<string,unknown>=type==='message'?{text:'Nova mensagem'}:type==='input'?{text:'Qual é sua resposta?',variable:'resposta'}:type==='variable'?{variable:'variavel',value:''}:type==='condition'?{field:'message',operator:'equals',value:''}:{};
  onChange({...graph,nodes:[...graph.nodes,{id,type,label:definition.label,position:{x:80+(graph.nodes.length%4)*270,y:80+Math.floor(graph.nodes.length/4)*190},data:defaults}]});
  setSelected(id);
 };
 const width=Math.max(1200,...graph.nodes.map(n=>n.position.x+300));
 const height=Math.max(650,...graph.nodes.map(n=>n.position.y+230));
 return <div className="flows-builder">
  <aside className="flows-palette"><h3>Blocos</h3><p>Construa o caminho da conversa.</p>
   {FLOW_NODE_CATALOG.map(c=><button type="button" key={c.type} disabled={!editable||graph.nodes.length>=150||(c.type==='start'&&graph.nodes.some(n=>n.type==='start'))} onClick={()=>add(c.type)} title={c.description}><span className={'flow-dot flow-dot--'+c.type}/>{c.label}</button>)}
   <small>Arraste os blocos. Clique em uma saída e depois no bloco de destino, ou use “Próximos passos”.</small>
  </aside>
  <section className="flows-canvas-wrap" aria-label="Canvas do flow">
   <div className="flows-canvas-tools"><button type="button" onClick={()=>setZoom(z=>Math.max(.3,z-.1))} aria-label="Diminuir zoom">−</button><span>{Math.round(zoom*100)}%</span><button type="button" onClick={()=>setZoom(z=>Math.min(1.5,z+.1))} aria-label="Aumentar zoom">+</button><button type="button" onClick={()=>setZoom(.75)}>Visão geral</button>{connecting&&<button type="button" onClick={()=>setConnecting(null)}>Cancelar conexão</button>}</div>
   <div className="flows-canvas-scroll">
    <div style={{width:width*zoom,height:height*zoom}}>
     <div className="flows-canvas" style={{width,height,transform:'scale('+zoom+')',transformOrigin:'top left'}}>
      <svg width={width} height={height} className="flows-wires" aria-label="Conexões entre blocos">
       {graph.edges.map(edge=>{
        const a=graph.nodes.find(n=>n.id===edge.source),b=graph.nodes.find(n=>n.id===edge.target);
        if(!a||!b)return null;
        const x=a.position.x+220,y=a.position.y+72+Math.max(0,flowPorts(a).indexOf(edge.port))*25;
        return <path key={edge.id} d={'M '+x+' '+y+' C '+(x+70)+' '+y+', '+(b.position.x-70)+' '+(b.position.y+45)+', '+b.position.x+' '+(b.position.y+45)}><title>{a.label+' → '+b.label}</title></path>;
       })}
      </svg>
      {graph.nodes.map(n=><div key={n.id} className={'flow-node '+(selected===n.id?'flow-node--selected ':'')+(!FLOW_NODE_CATALOG.some(c=>c.type===n.type)?'flow-node--unsupported':'')} style={{left:n.position.x,top:n.position.y}}>
       <button type="button" className="flow-node-heading" aria-label={'Configurar '+n.label}
        onClick={()=>{if(connecting&&editable&&n.type!=='start'&&connecting.source!==n.id)connect(connecting.source,connecting.port,n.id);else setSelected(n.id);}}
        onPointerDown={event=>{if(!editable||connecting)return;drag.current={id:n.id,x:event.clientX,y:event.clientY,originX:n.position.x,originY:n.position.y};event.currentTarget.setPointerCapture(event.pointerId);}}
        onPointerMove={event=>{const d=drag.current;if(d?.id!==n.id||!editable)return;const x=Math.min(100000,Math.max(0,d.originX+(event.clientX-d.x)/zoom)),y=Math.min(100000,Math.max(0,d.originY+(event.clientY-d.y)/zoom));if(Math.abs(event.clientX-d.x)+Math.abs(event.clientY-d.y)>3)onChange({...graph,nodes:graph.nodes.map(item=>item.id===n.id?{...item,position:{x,y}}:item)});}}
        onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}>
        <span className={'flow-dot flow-dot--'+n.type}/><strong>{n.label}</strong>
       </button>
       <small>{FLOW_NODE_CATALOG.find(c=>c.type===n.type)?.label??'Requer adaptação'}</small>
       <div className="flow-node-ports">{flowPorts(n).map(port=><button type="button" key={port} disabled={!editable} aria-label={'Conectar '+n.label+' '+portName(port)} onClick={()=>{setSelected(n.id);setConnecting({source:n.id,port});}}>{portName(port)}<span/></button>)}</div>
      </div>)}
     </div>
    </div>
   </div>
   <p className="flows-canvas-hint" aria-live="polite">{connecting?'Selecione o bloco de destino para esta saída.':'Conecte os blocos para definir a ordem de execução.'}</p>
  </section>
  <aside className="flows-inspector"><h3>Configurar bloco</h3>{node?<fieldset disabled={!editable}>
   <label>Nome do bloco<input value={node.label} maxLength={160} onChange={e=>patch({label:e.target.value})}/></label>
   {['message','input'].includes(node.type)&&<label>{node.type==='message'?'Mensagem':'Pergunta'}<textarea rows={5} maxLength={4096} value={String(node.data.text??'')} onChange={e=>data('text',e.target.value)}/></label>}
   {['input','variable'].includes(node.type)&&<label>Variável<input value={String(node.data.variable??'')} maxLength={100} onChange={e=>data('variable',e.target.value)}/></label>}
   {node.type==='condition'&&<><label>Campo<input value={String(node.data.field??'message')} onChange={e=>data('field',e.target.value)}/></label><label>Comparação<select value={String(node.data.operator??'equals')} onChange={e=>data('operator',e.target.value)}><option value="equals">Igual a</option><option value="not_equals">Diferente de</option><option value="contains">Contém</option><option value="starts_with">Começa com</option><option value="present">Está preenchido</option></select></label></>}
   {['variable','condition'].includes(node.type)&&<label>Valor<input value={String(node.data.value??'')} maxLength={4096} onChange={e=>data('value',e.target.value)}/></label>}
   {node.type==='unsupported'&&<p role="note">Este nó importado ainda não tem executor no Broker. Substitua-o por um bloco compatível. Origem: {String(node.data.sourceType??node.type)}</p>}
   {node.type==='handoff'&&<p>Ao chegar aqui, o chatbot pausa para o atendente. Retome em “Mensagens e automações”.</p>}
   <h4>Próximos passos</h4>{flowPorts(node).map(port=><label key={port}>{portName(port)}<select aria-label={'Destino '+portName(port)} value={graph.edges.find(e=>e.source===node.id&&e.port===port)?.target??''} onChange={e=>connect(node.id,port,e.target.value)}><option value="">Sem conexão</option>{graph.nodes.filter(n=>n.id!==node.id&&n.type!=='start').map(n=><option key={n.id} value={n.id}>{n.label}</option>)}</select></label>)}
   <p className="flows-help">Use {'{{contact.name}}'}, {'{{message}}'} ou a variável capturada, como {'{{nome}}'}.</p>
   {node.type!=='start'&&<button type="button" className="flows-delete" onClick={()=>{onChange({...graph,nodes:graph.nodes.filter(n=>n.id!==node.id),edges:graph.edges.filter(e=>e.source!==node.id&&e.target!==node.id)});setSelected(graph.nodes[0]?.id??'');}}>Remover bloco</button>}
  </fieldset>:<p>Selecione um bloco no canvas.</p>}</aside>
 </div>;
}
