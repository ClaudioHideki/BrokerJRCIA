import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessPoolInventory} from './preflight.mjs';
const names=['WEB','MESSAGING','AUTOMATION','AUTOMATION_IO','SCHEDULER','LIFECYCLE','PARTNER_EVENTS','HISTORY_IMPORT','HISTORY_SOURCE','MIGRATOR','EVOLUTION'];
function fixture(){return {schemaVersion:1,maxConnections:50,reservedConnections:10,processes:names.map(name=>name==='WEB'
 ? {name,replicas:1,rolloutReplicas:0,pools:{API_APP:10,API_AUTH:10,API_PLATFORM:4}}
 : {name,replicas:0,rolloutReplicas:0,pools:{}})};}
test('counts all three SQL pools per web replica instead of silently admitting only app connections',()=>{
 const input=fixture();input.maxConnections=30;
 const result=assessPoolInventory(input);
 assert.equal(result.sqlBudget.configuredConnections,24);
 assert.equal(result.sqlBudget.availableConnections,20);
 assert.equal(result.sqlBudget.headroomConnections,-4);
 assert.equal(result.admission,'OVER_BUDGET');
 assert.equal(result.capacityValidated,false);
});

test('rejects a missing auth or platform profile instead of computing misleading headroom',()=>{
 for(const missing of ['API_AUTH','API_PLATFORM']){
  const input=fixture();delete input.processes[0].pools[missing];
  assert.throws(()=>assessPoolInventory(input),{message:'POOL_INVENTORY_INCOMPLETE'});
 }
});
test('requires disabled processes to be explicitly declared, including workers and external SQL consumers',()=>{
 const input=fixture();input.processes=input.processes.filter(p=>p.name!=='PARTNER_EVENTS');
 assert.throws(()=>assessPoolInventory(input),{message:'POOL_INVENTORY_INCOMPLETE'});
});
test('distinguishes an explicitly disabled optional platform pool from an omitted pool',()=>{
 const input=fixture();input.processes[0].pools.API_PLATFORM=null;
 assert.equal(assessPoolInventory(input).sqlBudget.configuredConnections,20);
 input.processes[0].pools.API_AUTH=null;
 assert.throws(()=>assessPoolInventory(input),{message:'POOL_INVENTORY_REQUIRED_POOL_DISABLED'});
});

test('checks reserve and rollout exactly at the capacity boundary without increasing limits',()=>{
 const input=fixture(),before=structuredClone(input);input.maxConnections=34;
 assert.equal(assessPoolInventory(input).sqlBudget.headroomConnections,0);
 input.reservedConnections=11;
 assert.equal(assessPoolInventory(input).admission,'OVER_BUDGET');
 input.maxConnections=58;input.reservedConnections=10;input.processes[0].rolloutReplicas=1;
 assert.equal(assessPoolInventory(input).sqlBudget.headroomConnections,0);
 input.processes[0].rolloutReplicas=2;
 assert.equal(assessPoolInventory(input).sqlBudget.headroomConnections,-24);
 const snapshot=structuredClone(input);assessPoolInventory(input);assert.deepEqual(input,snapshot);
 assert.equal(before.maxConnections,50);
});
test('counts every declared worker and source profile alongside the web process',()=>{
 const input=fixture();input.maxConnections=100;input.reservedConnections=20;
 const pools={MESSAGING:{MESSAGING_WORKER:4,MESSAGING_AUTH:2},AUTOMATION:{AUTOMATION_WORKER:4},AUTOMATION_IO:{AUTOMATION_IO_WORKER:4},
  SCHEDULER:{SCHEDULER_WORKER:2},LIFECYCLE:{LIFECYCLE_WORKER:2},PARTNER_EVENTS:{PARTNER_EVENTS_WORKER:2},HISTORY_IMPORT:{HISTORY_IMPORT_WORKER:2},
  HISTORY_SOURCE:{HISTORY_SOURCE:1},MIGRATOR:{MIGRATOR:1},EVOLUTION:{EVOLUTION:10}};
 for(const process of input.processes)if(process.name!=='WEB'){process.replicas=1;process.pools=pools[process.name];}
 assert.equal(assessPoolInventory(input).sqlBudget.configuredConnections,58);
 input.processes[0].rolloutReplicas=1;
 assert.equal(assessPoolInventory(input).sqlBudget.worstCaseConnections,82);
 assert.equal(assessPoolInventory(input).sqlBudget.headroomConnections,-2);
});
test('rejects unsafe or out-of-bounds integer dimensions before computing a budget',()=>{
 for(const value of [Number.MAX_SAFE_INTEGER+1,Infinity,NaN,-1,1.5,'1'])for(const field of ['maxConnections','reservedConnections']){
  const input=fixture();input[field]=value;assert.throws(()=>assessPoolInventory(input),{message:'POOL_INVENTORY_INVALID'});
 }
 for(const field of ['replicas','rolloutReplicas']){
  const input=fixture();input.processes[0][field]=Number.MAX_SAFE_INTEGER+1;assert.throws(()=>assessPoolInventory(input),{message:'POOL_INVENTORY_INVALID'});
 }
 const input=fixture();input.processes[0].pools.API_APP=Number.MAX_SAFE_INTEGER+1;
 assert.throws(()=>assessPoolInventory(input),{message:'POOL_INVENTORY_INVALID'});
});
test('rejects unknown labels, secrets, duplicates and contradictory disabled declarations with static errors',()=>{
 const mutations=[input=>{input.password='private';},input=>{input.processes[0].pools.OTHER_SECRET_POOL=2;},input=>{input.processes[1].pools={MESSAGING_WORKER:4};},
  input=>{input.processes[1].rolloutReplicas=1;},input=>{input.processes[1].name='WEB';},input=>{input.processes[0].name='private@example.test';},
  input=>{Object.defineProperty(input.processes[0].pools,'API_APP',{enumerable:true,get(){throw Error('private');}});}];
 for(const mutate of mutations){const input=fixture();mutate(input);assert.throws(()=>assessPoolInventory(input),{message:'POOL_INVENTORY_INVALID'});}
});
test('requires an enabled declared process and bounds existing runtime-profile maxima',()=>{
 const input=fixture();input.processes[0]={name:'WEB',replicas:0,rolloutReplicas:0,pools:{}};
 assert.throws(()=>assessPoolInventory(input),{message:'POOL_INVENTORY_NO_ENABLED_PROCESS'});
 input.processes[0]={name:'WEB',replicas:1,rolloutReplicas:0,pools:{API_APP:101,API_AUTH:10,API_PLATFORM:4}};
 assert.throws(()=>assessPoolInventory(input),{message:'POOL_INVENTORY_INVALID'});
});

test('does not invent larger per-pool maxima for fixed one-connection history sources or migrators',()=>{
 for(const name of ['HISTORY_SOURCE','MIGRATOR']){
  const input=fixture(),process=input.processes.find(p=>p.name===name);process.replicas=1;process.pools={[name]:2};
  assert.throws(()=>assessPoolInventory(input),{message:'POOL_INVENTORY_INVALID'});
 }
});
test('returns the explicit sanitized inventory for review without modifying it',()=>{
 const input=fixture(),before=structuredClone(input),result=assessPoolInventory(input);
 assert.deepEqual(result.declarations,{source:'OPERATOR_INPUT',maxConnections:50,reservedConnections:10,processes:input.processes});
 assert.deepEqual(input,before);
});
