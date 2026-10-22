import { abortable, pinnedHttpsRequest, validateBrokerOrigin } from './safe-http.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const states=new Set(['PROVISIONING','CREATED','PROVISIONING_FAILED','CONNECTING','AWAITING_ACTION','CONNECTED','DISCONNECTING','DISCONNECTED','ERROR']);
const internalFault=Symbol('partner-qr-fault');
const fault=(status,code)=>Object.assign(new Error(code),{status,code,[internalFault]:true});
const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
const only=(value,keys)=>record(value)&&Object.keys(value).every(key=>keys.includes(key));
const identifiers=value=>value==='*'||Array.isArray(value)&&value.length<=1000&&value.every(id=>typeof id==='string'&&uuid.test(id));
const permits=(values,id)=>values==='*'||values.includes(id);
const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max;
function instance(value){
 if(!record(value)||!uuid.test(value.id)||!text(value.name,120)||value.provider!=='BAILEYS'||!states.has(value.status))throw fault(502,'BROKER_RESPONSE_INVALID');
 return {id:value.id,name:value.name,provider:'BAILEYS',status:value.status};
}
function action(value){
 if(!record(value))throw fault(502,'BROKER_RESPONSE_INVALID');
 if(value.type==='NONE'&&['ALREADY_CONNECTED','CONNECTION_PENDING','NO_USER_ACTION_REQUIRED'].includes(value.reason))return {type:'NONE',reason:value.reason};
 if(!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=Date.now())throw fault(409,'PAIRING_CHALLENGE_EXPIRED');
 if(value.type==='PAIRING_CODE'&&text(value.code,64))return {type:'PAIRING_CODE',code:value.code,expiresAt:value.expiresAt};
 if(value.type!=='QR_CODE')throw fault(422,'QR_ACTION_UNSUPPORTED');
 const encoded=value.encoding==='DATA_URL'&&typeof value.value==='string'&&value.value.startsWith('data:image/png;base64,')?value.value.slice(22):value.encoding==='BASE64'?value.value:null;
 if(typeof encoded!=='string'||!encoded.length||encoded.length>2_000_000||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded))throw fault(502,'BROKER_RESPONSE_INVALID');
 const bytes=Buffer.from(encoded,'base64');
 if(bytes.length>1_500_000||bytes.toString('base64')!==encoded||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw fault(502,'BROKER_RESPONSE_INVALID');
 return {type:'QR_CODE',encoding:'DATA_URL',value:'data:image/png;base64,'+encoded,expiresAt:value.expiresAt};
}
async function requestBody(req){
 if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(req.headers['content-type']??''))throw fault(415,'JSON_REQUIRED');
 if(Number(req.headers['content-length'])>4096)throw fault(413,'REQUEST_TOO_LARGE');
 return new Promise((resolve,reject)=>{
  const chunks=[];let size=0;
  const done=(error,value)=>{clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('aborted',aborted);req.off('error',aborted);error?reject(error):resolve(value);};
  const data=chunk=>{size+=chunk.length;if(size>4096){done(fault(413,'REQUEST_TOO_LARGE'));req.resume();}else chunks.push(chunk);};
  const end=()=>{try{done(null,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{done(fault(400,'INVALID_JSON'));}};
  const aborted=()=>done(fault(400,'REQUEST_INTERRUPTED'));
  const timer=setTimeout(()=>done(fault(408,'REQUEST_TIMEOUT')),5000);
  req.on('data',data);req.once('end',end);req.once('aborted',aborted);req.once('error',aborted);
 });
}
async function responseBody(response,signal){
 if(!response.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw fault(502,'BROKER_RESPONSE_INVALID');
 if(Number(response.headers.get('content-length'))>2_100_000)throw fault(502,'BROKER_RESPONSE_LIMIT');
 const reader=response.body?.getReader();if(!reader)throw fault(502,'BROKER_RESPONSE_INVALID');
 const chunks=[];let size=0;
 try{for(;;){const item=await abortable(reader.read(),signal);if(item.done)break;size+=item.value.length;if(size>2_100_000)throw fault(502,'BROKER_RESPONSE_LIMIT');chunks.push(item.value);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fault(502,'BROKER_RESPONSE_INVALID');}
 }finally{await reader.cancel().catch(()=>{});}
}
function route(req,base){
 if(typeof req.url!=='string'||!req.url.startsWith('/')||req.url.startsWith('//'))throw fault(404,'NOT_FOUND');
 const url=new URL(req.url,'http://host.invalid');
 if(!url.pathname.startsWith(base+'/'))throw fault(404,'NOT_FOUND');
 const path=url.pathname.slice(base.length),method=req.method;
 let operation,id;
 if(path==='/providers'&&method==='GET')operation='providers';
 else if(path==='/instances'&&method==='GET')operation='list';
 else if(path==='/instances'&&method==='POST')operation='create';
 else{const match=/^\/instances\/([^/]+)\/(status|pair|reconnect|disconnect)$/u.exec(path);if(match&&uuid.test(match[1])&&method===(match[2]==='status'?'GET':'POST')){id=match[1];operation=match[2];}}
 if(!operation)throw fault(404,'NOT_FOUND');
 const query=new URLSearchParams();
 for(const key of url.searchParams.keys())if(!['providers','list'].includes(operation)||!['cursor','limit'].includes(key)||url.searchParams.getAll(key).length!==1)throw fault(400,'INVALID_QUERY');
 const limit=url.searchParams.get('limit')??'100',cursor=url.searchParams.get('cursor');
 if(!/^(?:[1-9]\d?|100)$/u.test(limit)||cursor!==null&&!text(cursor.trim(),512))throw fault(400,'INVALID_QUERY');
 if(operation==='providers')query.set('provider','BAILEYS');
 if(['providers','list'].includes(operation)){query.set('limit',limit);if(cursor)query.set('cursor',cursor);}
 return {operation,id,query};
}
/** Mount behind the CCLX session middleware. No public, anonymous mode exists. */
export function createPartnerQrHandler({brokerOrigin,authorize,resolveCredentials,basePath='/jrc-qr',transport=pinnedHttpsRequest,timeoutMs=10000}={}){
 const origin=validateBrokerOrigin(brokerOrigin);
 if(typeof authorize!=='function'||typeof resolveCredentials!=='function'||typeof transport!=='function'||!/^\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+$/iu.test(basePath)||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000)throw new Error('INVALID_PARTNER_QR_CONFIGURATION');
 return async(req,res)=>{
  const send=(status,payload)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'});res.end(JSON.stringify(payload));};
  try{
   const {operation,id,query}=route(req,basePath),mutates=req.method==='POST';
   if(req.headers['sec-fetch-site']==='cross-site')throw fault(403,'HOST_ACCESS_DENIED');
   const grant=await authorize(req,{operation,...(id?{instanceId:id}:{})});
   const csrf=req.headers['x-csrf-token'];
   if(!record(grant)||grant.allow!==true||!text(grant.tenantRef,128)||!identifiers(grant.allowedInstanceIds)||!identifiers(grant.allowedProviderAccountIds)||mutates&&(grant.csrfVerified!==true||typeof csrf!=='string'||!text(csrf.trim(),1024)))throw fault(403,'HOST_ACCESS_DENIED');
   if(id&&!permits(grant.allowedInstanceIds,id))throw fault(403,'HOST_RESOURCE_DENIED');
   let body,idem;
   if(mutates){
    idem=req.headers['idempotency-key'];if(typeof idem!=='string'||!text(idem.trim(),255)||/[\r\n]/u.test(idem))throw fault(400,'IDEMPOTENCY_KEY_REQUIRED');
    const raw=await requestBody(req);
    if(operation==='create'){
     if(!only(raw,['name','providerAccountId'])||typeof raw.name!=='string'||!text(raw.name.trim(),120)||typeof raw.providerAccountId!=='string'||!uuid.test(raw.providerAccountId))throw fault(400,'INVALID_BODY');
     if(!permits(grant.allowedProviderAccountIds,raw.providerAccountId))throw fault(403,'HOST_RESOURCE_DENIED');
     body={name:raw.name.trim(),provider:'BAILEYS',providerAccountId:raw.providerAccountId};
    }else{
     if(!only(raw,operation==='disconnect'?[]:['pairingHint'])||raw.pairingHint!==undefined&&(typeof raw.pairingHint!=='string'||!text(raw.pairingHint.trim(),64)))throw fault(400,'INVALID_BODY');
     body=raw.pairingHint===undefined?{}:{pairingHint:raw.pairingHint.trim()};
    }
   }else if(Number(req.headers['content-length'])>0||req.headers['transfer-encoding'])throw fault(400,'INVALID_BODY');
   const credentials=await resolveCredentials(grant);
   if(!record(credentials)||!text(credentials.apiKey,512)||credentials.apiKey.length<16||/[\r\n]/u.test(credentials.apiKey))throw fault(503,'BROKER_NOT_CONFIGURED');
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs),aborted=()=>controller.abort();req.once('aborted',aborted);res.once('close',aborted);
   try{
    const upstream=async(path,method='GET',payload)=>{
     const headers={accept:'application/json','accept-encoding':'identity','x-jrc-api-key':credentials.apiKey};
     if(method==='POST'){headers['content-type']='application/json';headers['idempotency-key']=idem.trim();}
     try{
      controller.signal.throwIfAborted();
      const response=await abortable(transport(origin+path,{method,headers,redirect:'manual',signal:controller.signal,...(payload===undefined?{}:{body:JSON.stringify(payload)})}),controller.signal);
      if(response.status<200||response.status>=300){await response.body?.cancel().catch(()=>{});throw fault(response.status===409?409:response.status===403?403:502,response.status===409?'BROKER_RECONCILIATION_REQUIRED':'BROKER_REQUEST_REJECTED');}
      return {status:response.status,value:await responseBody(response,controller.signal)};
     }catch(error){if(controller.signal.aborted)throw fault(504,'BROKER_TIMEOUT');throw error;}
    };
    if(id&&mutates){const current=instance((await upstream('/v1/instances/'+id)).value);if(current.id!==id)throw fault(502,'BROKER_RESPONSE_INVALID');}
    const path=operation==='providers'?'/v1/provider-accounts?'+query:operation==='list'?'/v1/instances?'+query:operation==='create'?'/v1/instances':'/v1/instances/'+id+'/'+(operation==='pair'||operation==='reconnect'?'connect':operation);
    const {status,value}=await upstream(path,mutates?'POST':'GET',body);
    let projected;
    if(operation==='providers'||operation==='list'){
     if(!record(value)||!Array.isArray(value.data)||value.data.length>100||!record(value.pageInfo)||typeof value.pageInfo.hasNextPage!=='boolean'||value.pageInfo.nextCursor!==null&&!text(value.pageInfo.nextCursor,512)||value.pageInfo.hasNextPage&&!value.pageInfo.nextCursor)throw fault(502,'BROKER_RESPONSE_INVALID');
     const data=value.data.filter(item=>item.provider==='BAILEYS').map(item=>{
      if(operation==='list')return instance(item);
      if(!uuid.test(item.id)||!text(item.name,200))throw fault(502,'BROKER_RESPONSE_INVALID');return {id:item.id,name:item.name,provider:'BAILEYS'};
     }).filter(item=>permits(operation==='providers'?grant.allowedProviderAccountIds:grant.allowedInstanceIds,item.id));
     projected={data,pageInfo:{hasNextPage:value.pageInfo.hasNextPage,nextCursor:value.pageInfo.nextCursor}};
    }else if(operation==='status'){projected=instance(value);if(projected.id!==id)throw fault(502,'BROKER_RESPONSE_INVALID');}
    else{
     if(!record(value)||!['pending','replayed','reconciliationRequired'].every(key=>typeof value[key]==='boolean')||value.operationId!==null&&!uuid.test(value.operationId))throw fault(502,'BROKER_RESPONSE_INVALID');
     projected={instance:instance(value.instance),operationId:value.operationId,pending:value.pending,replayed:value.replayed,reconciliationRequired:value.reconciliationRequired};
     if(id&&projected.instance.id!==id)throw fault(502,'BROKER_RESPONSE_INVALID');
     if(operation==='pair'||operation==='reconnect')projected.action=action(value.action);
    }
    if(JSON.stringify(projected).includes(credentials.apiKey))throw fault(502,'BROKER_RESPONSE_INVALID');
    send(status,projected);
   }finally{clearTimeout(timer);req.off('aborted',aborted);res.off('close',aborted);}
  }catch(error){const known=error?.[internalFault]===true;send(known?error.status:502,{code:known?error.code:'PARTNER_QR_UNAVAILABLE',message:known?error.code:'A operação não foi confirmada. Consulte o estado antes de repetir.'});}
 };
}
