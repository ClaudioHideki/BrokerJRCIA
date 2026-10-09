import {randomUUID} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createLifecycleService,withLifecycleWorkerTransaction,type LifecycleTransaction} from '../../src/modules/lifecycle/service.js';

let db:Awaited<ReturnType<typeof attendanceDatabase>>,worker:Pool,platform:Pool;
function rolePool(role:string){const url=new URL(db.database.connectionString);url.username=role;url.password='';return new Pool({connectionString:url.href,max:1});}
beforeAll(async()=>{db=await attendanceDatabase();worker=rolePool('jrc_lifecycle');platform=rolePool('jrc_platform');});
afterAll(async()=>{await worker?.end();await platform?.end();await db?.dispose();});

async function fixture(pendingExternal=false){
  // A prior RED yield may leave REQUESTED work. Keep this isolated database's
  // earlier scenarios out of the next coordinator claim, without deleting data.
  await db.database.pool.query("UPDATE lifecycle_deletions SET status='ACTION_REQUIRED' WHERE status='REQUESTED'");
  const t=await seedAttendanceTenant(db.database,false),instance=randomUUID();
  const provider=(await db.database.pool.query('SELECT provider_account_id FROM messaging_channels WHERE id=$1',[t.channel])).rows[0]!.provider_account_id;
  await db.database.pool.query("UPDATE provider_accounts SET provider='BAILEYS' WHERE id=$1",[provider]);
  await db.database.pool.query(`INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status)
    VALUES($1,$2,$3,'Synthetic coordinator clock',$4,'CONNECTED')`,[instance,t.org,provider,`synthetic-${instance}`]);
  await db.database.pool.query("UPDATE messaging_channels SET provider='BAILEYS',instance_id=$2,phone_number_id=NULL,waba_id=NULL WHERE id=$1",[t.channel,instance]);
  const actor=(await db.database.pool.query("SELECT user_id FROM memberships WHERE organization_id=$1 AND role='OWNER'",[t.org])).rows[0]!.user_id;
  const id=(await platform.query('SELECT lifecycle_request_channel($1,$2,$3,$4,$5,$6) AS id',
    [t.org,instance,'Synthetic coordinator clock','Synthetic clock validation','TENANT',actor])).rows[0]!.id as string;
  if(!pendingExternal)await db.database.pool.query("UPDATE lifecycle_cleanup_items SET status='DONE' WHERE deletion_id=$1",[id]);
  return {...t,instance,id};
}
type TickPoint='FINAL'|'RENEW'|'YIELD'|'ACK';
async function blockedTick(point:TickPoint){
  const t=await fixture(point==='RENEW'||point==='ACK');
  let holder:PoolClient|undefined,holderPid=0,transactions=0,purgeCalls=0;
  let ready!:()=>void;
  const held=new Promise<void>(resolve=>{ready=resolve;});
  const workerPid=(await worker.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid as number;
  async function holdUntilExpired(){
    holder=await db.database.pool.connect();
    await holder.query("UPDATE lifecycle_deletions SET lease_expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",[t.id]);
    await holder.query('BEGIN');await holder.query('SELECT id FROM lifecycle_deletions WHERE id=$1 FOR UPDATE',[t.id]);
    holderPid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid as number;ready();
  }
  const transact:LifecycleTransaction=async work=>{
    if(++transactions===4&&point==='RENEW')await holdUntilExpired();
    return withLifecycleWorkerTransaction(worker,tx=>work({query:async(...args:unknown[])=>{
      if(typeof args[0]==='string'&&args[0].includes('SELECT public.lifecycle_purge_'))purgeCalls++;
      return Reflect.apply(tx.query,tx,args);
    }} as never));
  };
  const deprovision=vi.fn(async()=>{if(point==='ACK')await holdUntilExpired();});
  const cleanupPrivateMedia=vi.fn(async()=>{
    if(point==='FINAL'||point==='YIELD')await holdUntilExpired();
    return {state:point==='YIELD'?'PENDING' as const:'COMPLETE' as const};
  });
  const service=createLifecycleService({transact,deprovision,cleanupPrivateMedia});
  const running=service.processOne();
  try{
    await Promise.race([held,running.then(()=>{throw new Error('EXPECTED_COORDINATOR_CHECKPOINT_NOT_REACHED');})]);
    let blocked=false;
    for(let i=0;i<100;i++){
      if((await db.database.pool.query('SELECT $1::integer=ANY(pg_blocking_pids($2)) AS blocked',[holderPid,workerPid])).rows[0]!.blocked){blocked=true;break;}
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    expect(blocked).toBe(true);
    await holder!.query(`SELECT pg_sleep(GREATEST(0,extract(epoch FROM lease_expires_at-clock_timestamp()))+0.05)
      FROM lifecycle_deletions WHERE id=$1`,[t.id]);
    expect((await holder!.query('SELECT lease_expires_at<=clock_timestamp() AS expired FROM lifecycle_deletions WHERE id=$1',[t.id])).rows).toEqual([{expired:true}]);
    await holder!.query('COMMIT');
    expect(await running).toBe(true);
  }finally{
    if(holder){await holder.query('ROLLBACK');holder.release();}
    await running;
  }
  const state=(await db.database.pool.query('SELECT status,error_code FROM lifecycle_deletions WHERE id=$1',[t.id])).rows[0];
  return {t,state,purgeCalls,deprovision,cleanupPrivateMedia};
}
it('refuses final purge before calling the SQL purge when the lease expires behind the deletion row lock',async()=>{
  const h=await blockedTick('FINAL');
  expect(h.purgeCalls).toBe(0);
  expect(h.state).toMatchObject({status:'ACTION_REQUIRED',error_code:'EVOLUTION_CLEANUP_UNVERIFIED'});
  expect((await db.database.pool.query('SELECT id FROM messaging_channels WHERE id=$1',[h.t.channel])).rowCount).toBe(1);
});
it('does not renew an expired claim after a row lock wait or dispatch external deprovision',async()=>{
  const h=await blockedTick('RENEW');
  expect(h.deprovision).not.toHaveBeenCalled();expect(h.cleanupPrivateMedia).not.toHaveBeenCalled();expect(h.purgeCalls).toBe(0);
  expect(h.state).toMatchObject({status:'ACTION_REQUIRED',error_code:'EVOLUTION_CLEANUP_UNVERIFIED'});
});
it('does not requeue an expired private cleanup claim as a fresh REQUESTED operation',async()=>{
  const h=await blockedTick('YIELD');
  expect(h.purgeCalls).toBe(0);expect(h.state).toMatchObject({status:'ACTION_REQUIRED',error_code:'EVOLUTION_CLEANUP_UNVERIFIED'});
});
it('does not confirm a delayed external ACK or start private cleanup after the current lease expires behind a lock',async()=>{
  const h=await blockedTick('ACK');
  expect(h.deprovision).toHaveBeenCalledOnce();expect(h.cleanupPrivateMedia).not.toHaveBeenCalled();expect(h.purgeCalls).toBe(0);
  expect(h.state).toMatchObject({status:'ACTION_REQUIRED',error_code:'EVOLUTION_CLEANUP_UNVERIFIED'});
  expect((await db.database.pool.query('SELECT status FROM lifecycle_cleanup_items WHERE deletion_id=$1',[h.t.id])).rows).toEqual([{status:'IN_FLIGHT'}]);
});
it.each(['COMPLETE','PENDING'] as const)('preserves a fresh private cleanup result %s with the nominative lease',async result=>{
  const t=await fixture();let purges=0;
  const transact:LifecycleTransaction=work=>withLifecycleWorkerTransaction(worker,tx=>work({query:async(...args:unknown[])=>{
    if(typeof args[0]==='string'&&args[0].includes('SELECT public.lifecycle_purge_'))purges++;
    return Reflect.apply(tx.query,tx,args);
  }} as never));
  const service=createLifecycleService({transact,deprovision:vi.fn(),cleanupPrivateMedia:async()=>({state:result})});
  expect(await service.processOne()).toBe(true);
  expect(purges).toBe(result==='COMPLETE'?1:0);
  expect((await db.database.pool.query('SELECT status,lease_token FROM lifecycle_deletions WHERE id=$1',[t.id])).rows)
    .toEqual([{status:result==='COMPLETE'?'COMPLETED':'REQUESTED',lease_token:null}]);
  expect((await db.database.pool.query('SELECT id FROM messaging_channels WHERE id=$1',[t.channel])).rowCount).toBe(result==='COMPLETE'?0:1);
});
