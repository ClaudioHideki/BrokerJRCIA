import {BoxRoutingConfigSchema,type AttendanceCatalog} from '@jrc/contracts';
export const org='11111111-1111-4111-8111-111111111111',channel='22222222-2222-4222-8222-222222222222',integration='33333333-3333-4333-8333-333333333333';
export function catalog():AttendanceCatalog{return {
 scope:{organizationId:org,channelId:channel,integrationId:integration,destinationRevision:1,accountId:1,inboxId:20},
 observedAt:'2030-01-01T00:00:00.000Z',credentialRevision:1,teams:[{id:10,name:'Comercial',autoAssignment:false}],
 agents:[{id:1,name:'Ana',inboxMember:true},{id:2,name:'Bruno',inboxMember:true},{id:3,name:'Fora',inboxMember:false}],
 labels:[],attributes:[],hours:{enabled:false,timezone:null,days:[]},remoteBot:null,
 inboxPolicy:{greetingEnabled:false,autoAssignmentEnabled:false},
 capabilities:{teams:'SUPPORTED',agents:'SUPPORTED',inboxMembership:'SUPPORTED',labels:'SUPPORTED',attributes:'SUPPORTED',hours:'SUPPORTED',agentBot:'SUPPORTED',signatures:'UNVERIFIED',controlEvents:'SUPPORTED',initialPending:'SUPPORTED'},
};}
export const config=()=>BoxRoutingConfigSchema.parse({schemaVersion:1,routes:[{routeKey:'sales',teamId:10,mode:'AGENT',membership:'ALL',agentIds:[]}]});
