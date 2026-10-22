import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

const blocked=new BlockList(),publicV6=new BlockList();
for(const [address,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.31.196.0',24],['192.52.193.0',24],['192.88.99.0',24],['192.168.0.0',16],['192.175.48.0',24],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])blocked.addSubnet(address,bits,'ipv4');
for(const [address,bits] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20],['2620:4f:8000::',48]])blocked.addSubnet(address,bits,'ipv6');
publicV6.addSubnet('2000::',3,'ipv6');
export function assertPublicAddresses(addresses){
 if(!addresses.length||addresses.some(address=>{const family=isIP(address);return !family||address.includes('%')||(family===4?blocked.check(address,'ipv4'):!publicV6.check(address,'ipv6')||blocked.check(address,'ipv6'));}))throw new Error('UNSAFE_BROKER_ADDRESS');
}
export function validateBrokerOrigin(value){
 const url=new URL(value),host=url.hostname;
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash||/[\\\s]/u.test(value)||isIP(host.replace(/^\[|\]$/g,''))||host.length>253||!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/iu.test(host)||/(?:^|\.)(?:localhost|local|internal|invalid|home|lan|onion)$/u.test(host))throw new Error('INVALID_BROKER_ORIGIN');
 return url.origin;
}
export function abortable(promise,signal){
 signal.throwIfAborted();
 return new Promise((resolve,reject)=>{const abort=()=>reject(new Error('BROKER_TIMEOUT'));signal.addEventListener('abort',abort,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
/** Public DNS is validated and pinned to this request's TLS socket. No redirects or pooled sockets. */
export async function pinnedHttpsRequest(url,init){
 const target=new URL(url),signal=init.signal;
 const addresses=(await abortable(lookup(target.hostname,{all:true,verbatim:true}),signal)).map(row=>row.address);
 assertPublicAddresses(addresses);
 return abortable(new Promise((resolve,reject)=>{
  const address=addresses[0],family=isIP(address);
  const req=request(target,{method:init.method,headers:init.headers,agent:false,servername:target.hostname,rejectUnauthorized:true,signal,
   lookup:(_host,options,callback)=>options.all?callback(null,[{address,family}]):callback(null,address,family)},res=>{
   const chunks=[];let size=0;
   if(Number(res.headers['content-length'])>2_100_000||res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){req.destroy(new Error('BROKER_RESPONSE_LIMIT'));return;}
   res.on('data',chunk=>{size+=chunk.length;if(size>2_100_000)req.destroy(new Error('BROKER_RESPONSE_LIMIT'));else chunks.push(chunk);});
   res.on('error',reject);res.on('aborted',()=>reject(new Error('BROKER_RESPONSE_INTERRUPTED')));
   res.on('end',()=>{try{resolve(new Response([204,205,304].includes(res.statusCode)?null:Buffer.concat(chunks),{status:res.statusCode??502,headers:{'content-type':String(res.headers['content-type']??'')}}));}catch(error){reject(error);}});
  });req.on('error',reject);req.end(init.body);
 }),signal);
}
