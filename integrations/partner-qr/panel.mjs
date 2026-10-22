const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STATES=new Set(['PROVISIONING','CREATED','PROVISIONING_FAILED','CONNECTING','AWAITING_ACTION','CONNECTED','DISCONNECTING','DISCONNECTED','ERROR']);
const labels={PROVISIONING:'Em provisionamento',CREATED:'Criada',PROVISIONING_FAILED:'Falha no cadastro',CONNECTING:'Conectando',AWAITING_ACTION:'Aguardando pareamento',CONNECTED:'Conectada',DISCONNECTING:'Desconectando',DISCONNECTED:'Desconectada',ERROR:'Conferência necessária'};
function safeQr(action){
 if(action.type!=='QR_CODE'||action.encoding!=='DATA_URL'||typeof action.value!=='string'||!action.value.startsWith('data:image/png;base64,')||Date.parse(action.expiresAt)<=Date.now())throw new Error('QR Code inválido ou inseguro. Consulte o estado antes de solicitar outro.');
 const encoded=action.value.slice(22);
 if(!encoded.length||encoded.length>2_000_000||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded))throw new Error('QR Code inválido ou inseguro.');
 let bytes;try{bytes=atob(encoded);}catch{throw new Error('QR Code inválido ou inseguro.');}
 if(bytes.length>1_500_000||btoa(bytes)!==encoded||![137,80,78,71,13,10,26,10].every((byte,index)=>bytes.charCodeAt(index)===byte))throw new Error('QR Code inválido ou inseguro.');
 return action.value;
}
/** A host-session panel. It never accepts, stores or sends a Broker API key. */
export function mountQRCodePanel(container,{apiBase,csrfToken,pollIntervalMs=4000,maxPolls=30}={}){
 if(!container?.ownerDocument||!/^\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+$/iu.test(apiBase)||!Number.isInteger(pollIntervalMs)||pollIntervalMs<1000||pollIntervalMs>10000||!Number.isInteger(maxPolls)||maxPolls<1||maxPolls*pollIntervalMs>120000)throw new Error('Invalid QR panel configuration');
 const doc=container.ownerDocument,win=doc.defaultView;
 let destroyed=false,busy=false,instances=[],providers=[],pollTimer,expiryTimer,polls=0,uncertainIntent=null,epoch=0;
 const controllers=new Set(),operationKeys=new Map();
 const el=(tag,text,attributes={})=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;for(const [name,value] of Object.entries(attributes))node.setAttribute(name,value);return node;};
 const root=el('section',undefined,{class:'jrc-partner-qr','aria-label':'Conexão WhatsApp JRC'});
 const heading=el('h2','WhatsApp por QR Code'),notice=el('p','Consultando conexões…',{role:'status','aria-live':'polite'}),error=el('p','',{role:'alert'});
 const picker=el('select',undefined,{'aria-label':'Conexão'}),status=el('p',''),challenge=el('div',undefined,{'aria-live':'polite'});
 const refreshButton=el('button','Atualizar'),pairButton=el('button','Parear'),reconnectButton=el('button','Reconectar'),disconnectButton=el('button','Desconectar');
 for(const button of [refreshButton,pairButton,reconnectButton,disconnectButton])button.type='button';
 const controls=el('div',undefined,{class:'jrc-partner-qr-actions'});controls.append(refreshButton,pairButton,reconnectButton,disconnectButton);
 const form=el('form'),name=el('input',undefined,{name:'name',maxlength:'120',required:'','aria-label':'Nome da conexão'}),provider=el('select',undefined,{'aria-label':'Conta de conexão QR'}),createButton=el('button','Criar conexão');createButton.type='submit';
 form.append(el('h3','Nova conexão'),el('label','Nome'),name,el('label','Conta autorizada'),provider,createButton);
 root.append(heading,notice,error,picker,status,controls,challenge,form,el('p','Conectado confirma o transporte. Mensagens, bot e entrega no atendimento precisam de validação própria.'));
 container.replaceChildren(root);
 const current=()=>instances.find(item=>item.id===picker.value);
 function buttons(){
  refreshButton.disabled=busy;picker.disabled=busy;
  pairButton.disabled=busy||!current()||Boolean(uncertainIntent&&uncertainIntent!=='connect:'+picker.value);
  reconnectButton.disabled=pairButton.disabled;disconnectButton.disabled=busy||!current()||Boolean(uncertainIntent);
  createButton.disabled=busy||!providers.length||Boolean(uncertainIntent&&!uncertainIntent.startsWith('create:'));
 }
 function clearChallenge(){clearTimeout(expiryTimer);expiryTimer=undefined;challenge.replaceChildren();}
 function stopPolling(){clearTimeout(pollTimer);pollTimer=undefined;polls=0;}
 function renderLists(){
  const selected=picker.value;picker.replaceChildren(...instances.map(item=>{const option=el('option',item.name,{value:item.id});return option;}));
  if(instances.some(item=>item.id===selected))picker.value=selected;
  provider.replaceChildren(...providers.map(item=>el('option',item.name,{value:item.id})));
  status.textContent=current()?labels[current().status]:'Nenhuma conexão QR autorizada.';buttons();
 }
 async function request(path,{method='GET',body,key}={}){
  const controller=new AbortController();controllers.add(controller);const timeout=setTimeout(()=>controller.abort(),10000);
  try{
   const headers={accept:'application/json'};
   if(method==='POST'){
    const token=typeof csrfToken==='function'?csrfToken():csrfToken;
    if(typeof token!=='string'||!token||token.length>1024||/[\r\n]/u.test(token))throw new Error('O host precisa fornecer o token CSRF da sessão.');
    headers['content-type']='application/json';headers['x-csrf-token']=token;headers['idempotency-key']=key;
   }
   const response=await fetch(apiBase+path,{method,headers,credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,...(body===undefined?{}:{body:JSON.stringify(body)})});
   if(!response.ok)throw new Error(response.status===403?'O host não autorizou esta operação.':'A operação não foi confirmada. Consulte o estado antes de repetir.');
   const raw=await response.text();if(raw.length>2_100_000)throw new Error('Resposta inválida do adaptador.');
   return JSON.parse(raw);
  }finally{clearTimeout(timeout);controllers.delete(controller);}
 }
 async function pages(path){
  let cursor;const found=new Map(),seen=new Set();
  for(let page=0;page<10;page++){
   const value=await request('/'+path+(cursor?'?cursor='+encodeURIComponent(cursor):''));
   if(!Array.isArray(value?.data)||value.data.length>100||typeof value.pageInfo?.hasNextPage!=='boolean')throw new Error('Listagem inválida do adaptador.');
   for(const item of value.data){if(!UUID.test(item?.id)||typeof item.name!=='string'||item.name.length>200||item.provider!=='BAILEYS'||path==='instances'&&!STATES.has(item.status))throw new Error('Listagem inválida do adaptador.');found.set(item.id,item);}
   if(!value.pageInfo.hasNextPage)return [...found.values()];
   cursor=value.pageInfo.nextCursor;if(typeof cursor!=='string'||!cursor||cursor.length>512||seen.has(cursor))throw new Error('Paginação inválida do adaptador.');seen.add(cursor);
  }throw new Error('A listagem excedeu o limite de dez páginas. Restrinja os recursos no host.');
 }
 async function refresh(){
  if(destroyed||busy)return;const generation=++epoch;busy=true;buttons();error.textContent='';clearChallenge();stopPolling();
  try{const values=await Promise.all([pages('providers'),pages('instances')]);if(destroyed||generation!==epoch)return;[providers,instances]=values;renderLists();notice.textContent=uncertainIntent?'A operação anterior não foi confirmada. Consulte o resultado antes de repetir; a mesma intenção reutiliza a chave.':'Estado consultado no servidor do host.';}
  catch(failure){if(!destroyed&&generation===epoch){instances=[];providers=[];renderLists();error.textContent=failure.message;notice.textContent='Consulta indisponível.';}}
  finally{if(!destroyed&&generation===epoch){busy=false;buttons();}}
 }
 function displayAction(action){
  clearChallenge();if(!action||typeof action.type!=='string')throw new Error('Resposta de pareamento inválida.');
  if(action.type==='NONE'){notice.textContent=action.reason==='ALREADY_CONNECTED'?'WhatsApp já conectado.':'Pareamento em processamento. Consulte o estado; nenhum novo comando será enviado automaticamente.';return;}
  const expires=Date.parse(action.expiresAt);if(!Number.isFinite(expires)||expires<=Date.now())throw new Error('O desafio de pareamento expirou. Consulte o estado antes de solicitar outro.');
  if(action.type==='QR_CODE'){const image=el('img',undefined,{src:safeQr(action),alt:'QR Code para conectar WhatsApp',width:'280',height:'280'});challenge.append(el('p','No WhatsApp, abra Aparelhos conectados e leia este QR Code.'),image);}
  else if(action.type==='PAIRING_CODE'&&typeof action.code==='string'&&action.code.length<=64)challenge.append(el('p','Código de pareamento'),el('strong',action.code));
  else throw new Error('Ação de pareamento não suportada pelo painel QR.');
  expiryTimer=setTimeout(()=>{clearChallenge();notice.textContent='O desafio de pareamento expirou. Consulte o estado antes de solicitar outro.';},Math.min(expires-Date.now(),2147483647));
 }
 async function poll(id,generation,intent,target='CONNECTED'){
  if(destroyed||generation!==epoch||picker.value!==id)return;
  try{
   const item=await request('/instances/'+id+'/status');if(destroyed||generation!==epoch)return;
   if(item?.id!==id||item.provider!=='BAILEYS'||!STATES.has(item.status))throw new Error('Estado inválido do adaptador.');
   const index=instances.findIndex(value=>value.id===id);if(index>=0)instances[index]={...instances[index],status:item.status};status.textContent=labels[item.status];
   if(item.status===target||target==='CREATED'&&item.status==='DISCONNECTED'){clearChallenge();uncertainIntent=null;operationKeys.delete(intent);notice.textContent=target==='DISCONNECTED'?'Desconexão confirmada pelo servidor.':target==='CREATED'?'Cadastro confirmado pelo servidor. Solicite o pareamento explicitamente.':'Conexão confirmada pelo servidor.';buttons();return;}
  }catch(failure){if(!destroyed&&generation===epoch){clearChallenge();error.textContent=failure.message;notice.textContent='Consulta interrompida. Use Atualizar para conferir o estado.';}return;}
  polls++;if(polls>=maxPolls){notice.textContent='O limite de consultas foi atingido. Use Atualizar para consultar o estado.';return;}
  pollTimer=setTimeout(()=>void poll(id,generation,intent,target),pollIntervalMs);
 }
 async function mutate(operation,body={}){
  if(destroyed||busy)return;if(operation!=='create'&&!current())return;
  if(operation==='disconnect'&&!win.confirm('Desconectar este WhatsApp? Será necessário parear novamente. O histórico será preservado.'))return;
  const id=picker.value,intent=operation==='create'?'create:'+JSON.stringify(body):operation==='disconnect'?'disconnect:'+id:'connect:'+id;
  if(uncertainIntent&&uncertainIntent!==intent){error.textContent='Confira a operação anterior antes de iniciar outra intenção.';return;}
  const generation=++epoch;stopPolling();clearChallenge();busy=true;buttons();error.textContent='';
  let key=operationKeys.get(intent);if(!key){key=win.crypto.randomUUID();operationKeys.set(intent,key);}
  try{
   const value=await request(operation==='create'?'/instances':'/instances/'+id+'/'+operation,{method:'POST',body,key});if(destroyed||generation!==epoch)return;
   if(!UUID.test(value?.instance?.id)||value.instance.provider!=='BAILEYS'||!STATES.has(value.instance.status)||typeof value.instance.name!=='string'||typeof value.pending!=='boolean'||typeof value.reconciliationRequired!=='boolean')throw new Error('Resposta inválida do adaptador.');
   if(operation!=='create'&&value.instance.id!==id)throw new Error('Resposta inválida do adaptador.');
   instances=[...instances.filter(item=>item.id!==value.instance.id),value.instance];renderLists();picker.value=value.instance.id;status.textContent=labels[value.instance.status];
   if(value.reconciliationRequired){uncertainIntent=intent;throw new Error('A operação não foi confirmada. Reconcilie o resultado antes de repetir.');}
   uncertainIntent=value.pending?intent:null;if(!value.pending)operationKeys.delete(intent);
   notice.textContent=value.pending?'Operação em processamento. O aceite não confirma a conexão.':'Operação confirmada pelo adaptador; confira o estado da conexão.';
   if(operation==='pair'||operation==='reconnect')displayAction(value.action);
   if(value.pending||['QR_CODE','PAIRING_CODE'].includes(value.action?.type))pollTimer=setTimeout(()=>void poll(value.instance.id,generation,intent,operation==='disconnect'?'DISCONNECTED':operation==='create'?'CREATED':'CONNECTED'),pollIntervalMs);
  }catch(failure){if(!destroyed&&generation===epoch){uncertainIntent=intent;error.textContent=failure.message?.includes('inválid')||failure.message?.includes('inseguro')||failure.message?.includes('suportada')||failure.message?.includes('CSRF')?failure.message:'A operação não foi confirmada. Consulte o estado antes de repetir; a mesma intenção reutiliza a chave.';}}
  finally{if(!destroyed&&generation===epoch){busy=false;buttons();}}
 }
 refreshButton.addEventListener('click',()=>void refresh());pairButton.addEventListener('click',()=>void mutate('pair'));reconnectButton.addEventListener('click',()=>void mutate('reconnect'));disconnectButton.addEventListener('click',()=>void mutate('disconnect'));
 picker.addEventListener('change',()=>{epoch++;stopPolling();clearChallenge();status.textContent=current()?labels[current().status]:'';buttons();});
 form.addEventListener('submit',event=>{event.preventDefault();if(!name.value.trim()||name.value.trim().length>120||!UUID.test(provider.value))return;void mutate('create',{name:name.value.trim(),providerAccountId:provider.value});});
 const ready=refresh();
 return {ready,refresh,destroy(){if(destroyed)return;destroyed=true;epoch++;stopPolling();clearChallenge();controllers.forEach(controller=>controller.abort());controllers.clear();operationKeys.clear();container.replaceChildren();}};
}
