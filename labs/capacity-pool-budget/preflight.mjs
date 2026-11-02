import {buildCapacityReport} from '../../scripts/operations/capacity-report.mjs';

const profiles={WEB:{API_APP:'API',API_AUTH:'AUTH',API_PLATFORM:'PLATFORM'},MESSAGING:{MESSAGING_WORKER:'MESSAGING',MESSAGING_AUTH:'MESSAGING_AUTH'},
 AUTOMATION:{AUTOMATION_WORKER:'AUTOMATION'},AUTOMATION_IO:{AUTOMATION_IO_WORKER:'AUTOMATION_IO'},SCHEDULER:{SCHEDULER_WORKER:'SCHEDULER'},
 LIFECYCLE:{LIFECYCLE_WORKER:'LIFECYCLE'},PARTNER_EVENTS:{PARTNER_EVENTS_WORKER:'PARTNER_EVENTS'},HISTORY_IMPORT:{HISTORY_IMPORT_WORKER:'HISTORY_IMPORT'},
 HISTORY_SOURCE:{HISTORY_SOURCE:'HISTORY_SOURCE'},MIGRATOR:{MIGRATOR:'MIGRATOR'},EVOLUTION:{EVOLUTION:'EVOLUTION'}};
const optional=new Set(['API_PLATFORM','MESSAGING_AUTH']);
const external=new Set(['HISTORY_SOURCE','MIGRATOR','EVOLUTION']);
const fail=code=>{throw Error(code??'POOL_INVENTORY_INVALID');};
function object(value,keys){
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail();
 for(const key of Reflect.ownKeys(value)){
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(typeof key!=='string'||!keys.includes(key)||!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))fail();
 }
 for(const key of keys)if(!Object.hasOwn(value,key))fail('POOL_INVENTORY_INCOMPLETE');
}
function integer(value,min,max){if(!Number.isSafeInteger(value)||value<min||value>max)fail();}
function validate(input){
 object(input,['schemaVersion','maxConnections','reservedConnections','processes']);
 if(input.schemaVersion!==1)fail();
 integer(input.maxConnections,1,1000000);integer(input.reservedConnections,0,input.maxConnections);
 if(!Array.isArray(input.processes)||input.processes.length>Object.keys(profiles).length)fail();
 const seen=new Set();
 for(const process of input.processes){
  object(process,['name','replicas','rolloutReplicas','pools']);
  if(typeof process.name!=='string'||!Object.hasOwn(profiles,process.name)||seen.has(process.name))fail();
  seen.add(process.name);
  integer(process.replicas,0,10000);integer(process.rolloutReplicas,0,10000);
  if(!process.replicas){
   if(process.rolloutReplicas)fail();
   object(process.pools,[]);
   continue;
  }
  object(process.pools,Object.keys(profiles[process.name]));
  for(const [profile,max] of Object.entries(process.pools)){
   if(max===null){if(!optional.has(profile))fail('POOL_INVENTORY_REQUIRED_POOL_DISABLED');}
   else integer(max,1,['HISTORY_SOURCE','MIGRATOR'].includes(process.name)?1:external.has(process.name)?1000000:profile==='HISTORY_IMPORT_WORKER'?8:100);
  }
 }
 if(seen.size!==Object.keys(profiles).length)fail('POOL_INVENTORY_INCOMPLETE');
 if(!input.processes.some(process=>process.replicas>0))fail('POOL_INVENTORY_NO_ENABLED_PROCESS');
}

/** Offline declarations only. Uses existing capacity-report arithmetic, never opens a SQL pool. */
export function assessPoolInventory(input){
 validate(input);
 const components=[];
 for(const process of input.processes){
  if(process.replicas===0&&process.rolloutReplicas===0)continue;
  for(const [profile,maxPerReplica] of Object.entries(process.pools)){
   if(maxPerReplica===null)continue;
   components.push({name:profiles[process.name][profile],replicas:process.replicas,maxPerReplica,rolloutReplicas:process.rolloutReplicas});
  }
 }
 const report=buildCapacityReport({schemaVersion:1,workload:{organizations:1,connections:0,monthlyConversations:0,messagesPerConversation:1,
  daysPerMonth:30,peakMultiplier:1,mediaFraction:0,meanMediaBytes:0,retentionDays:0},
  pools:{maxConnections:input.maxConnections,reservedConnections:input.reservedConnections,components}});
 return {schemaVersion:1,kind:'DECLARED_POOL_BUDGET_PREFLIGHT',capacityValidated:false,
  declarations:{source:'OPERATOR_INPUT',maxConnections:input.maxConnections,reservedConnections:input.reservedConnections,
   processes:input.processes.map(process=>({name:process.name,replicas:process.replicas,rolloutReplicas:process.rolloutReplicas,pools:{...process.pools}}))},
  admission:report.sqlBudget.withinConfiguredBudget?'WITHIN_DECLARED_BUDGET':'OVER_BUDGET',sqlBudget:report.sqlBudget};
}
