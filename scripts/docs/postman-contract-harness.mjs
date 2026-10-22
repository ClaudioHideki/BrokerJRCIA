// Local HTTP contract harness: real Fastify routes/guards/serialization; synthetic services/provider.
// Database durability is covered separately by PostgreSQL integration tests. Never use this server in production.
import {buildApp} from '../../apps/api/dist/app.js';
import {writeFile,mkdir} from 'node:fs/promises';
import {buildPocPostman} from './postman-poc.mjs';
const id='11111111-1111-4111-8111-111111111111',org='22222222-2222-4222-8222-222222222222';
const key='synthetic-local-postman-key',now='2026-10-22T17:00:00.000Z';
const auth={jwtSecret:'synthetic-contract-jwt-secret-over-32-characters',authenticateApiKey:async raw=>raw===key?{apiKeyId:id,organizationId:org,scopes:['instances:read','instances:write','messaging:read','messaging:send','webhooks:manage']}:null};
let state='CREATED',endpointStatus='ACTIVE';
const instance=()=>({id,organizationId:org,providerAccountId:id,name:'POC API JRC',provider:'BAILEYS',status:state,createdAt:now,updatedAt:now});
const page=data=>({data,pageInfo:{hasNextPage:false,nextCursor:null}});
const mutation=()=>({instance:instance(),operationId:null,replayed:false,pending:false,reconciliationRequired:false});
const endpoint=()=>({id,url:'https://receiver.example/hooks/jrc',status:endpointStatus,createdAt:now,revokedAt:endpointStatus==='REVOKED'?now:null});
const channel={id,instanceId:id,provider:'BAILEYS',ownerRevision:0,botPublicId:null};
const conversation={id,channelId:id,contactId:id,mode:'HUMAN'};
let messages=[];
const app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({async verifyPasswordOrDummy(){return false;}}),
 providerAccounts:{...auth,service:{listProviderAccounts:async()=>page([{id,name:'Provedor sintético',provider:'BAILEYS',createdAt:now}])}},
 instances:{...auth,service:{createInstance:async()=>mutation(),listInstances:async()=>page([instance()]),getInstance:async()=>instance(),getInstanceStatus:async()=>instance(),connectInstance:async()=>{state='CONNECTED';return{...mutation(),action:{type:'NONE',reason:'ALREADY_CONNECTED'}};},disconnectInstance:async()=>{state='DISCONNECTED';return mutation();}}},
 integrations:{...auth,resolveCurrentRole:async()=> 'OWNER',qr:{activate:async()=>channel}},
 messaging:{...auth,resolveCurrentRole:async()=> 'OWNER',service:{readMedia:async()=>({bytes:new Uint8Array([1,2,3]),mimeType:'image/png',kind:'image',fileName:'synthetic.png'}),listChannels:async()=>({data:[channel]}),listConversations:async()=>({data:[conversation]}),getConversation:async()=>conversation,listMessages:async()=>({data:messages}),sendPartnerText:async(_org,_channel,input)=>{const message={id,conversationId:id,direction:'OUTGOING',state:'ACCEPTED',text:input.text};messages.push(message);return message;}}},
 partnerWebhooks:{...auth,service:{create:async()=>({endpoint:endpoint(),signingSecret:'synthetic-only-independent-signing-secret',replayed:false}),list:async()=>({data:[endpoint()]}),revoke:async()=>{endpointStatus='REVOKED';return endpoint();},events:async()=>({schemaVersion:1,retentionDays:30,earliestCursor:null,lastPrunedCursor:'0',nextCursor:'0',data:[]}),deliveries:async()=>({data:[]})}}
});
await app.listen({port:0,host:'127.0.0.1'});
const origin='http://127.0.0.1:'+app.server.address().port;
await mkdir('.sessions/postman',{recursive:true});
await writeFile('.sessions/postman/collection.json',JSON.stringify(buildPocPostman(),null,2));
await writeFile('.sessions/postman/environment.json',JSON.stringify({name:'LOCAL SYNTHETIC CONTRACTS ONLY',values:Object.entries({broker_origin:origin,jrc_api_key:key,allow_writes:'true',media_id:id,test_recipient:'+12025550123',receiver_url:'https://receiver.example/hooks/jrc'}).map(([key,value])=>({key,value,enabled:true}))},null,2));
console.log(JSON.stringify({mode:'LOCAL_HTTP_CONTRACTS_SYNTHETIC_SERVICES',origin,operations:19}));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{await app.close();process.exit(0);});
