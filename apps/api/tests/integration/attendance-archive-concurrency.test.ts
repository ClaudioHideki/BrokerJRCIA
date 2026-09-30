import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
import { createAutomationService } from '../../src/modules/automations/service.js';
import { createPostgresAutomationRepository } from '../../src/modules/automations/repository.js';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';

describe('attendance owner archival lock order', () => {
  let db: Awaited<ReturnType<typeof attendanceDatabase>>;
  beforeAll(async () => { db = await attendanceDatabase(); }, 60000);
  afterAll(async () => db?.dispose());

  it('serializes archive against the real router without a channel/binding deadlock', async () => {
    const t = await seedAttendanceTenant(db.database, false);
    await db.database.pool.query('insert into flow_features(organization_id,enabled) values($1,true)', [t.org]);
    const service = createAutomationService({ transact: db.transact });
    await service.bind(t.org, t.automation, { channelId: t.channel, version: 1, expectedOwnerRevision: 0 });

    let bindingsLocked!: () => void, releaseArchive!: () => void;
    const bindingBarrier = new Promise<void>(resolve => { bindingsLocked = resolve; });
    const archiveBarrier = new Promise<void>(resolve => { releaseArchive = resolve; });
    let archivePid = 0;
    const archiveService = createAutomationService({ transact: (org, work) => db.transact(org, async tx => {
      await tx.query("set local statement_timeout='8000ms'");
      archivePid = (await tx.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid;
      const observed = { query: async (sql: string, args?: unknown[]) => {
        const result = await tx.query(sql, args);
        if (sql.includes('select id from automation_bindings') && sql.includes('for update')) {
          bindingsLocked();
          await archiveBarrier;
        }
        return result;
      } } as TenantTransaction;
      return work(observed);
    }) });
    const archive = archiveService.setArchived(t.org, t.automation, true).then(value => ({ value }), error => ({ error }));
    await bindingBarrier;
    let routerPid = 0;
    const router = db.transact(t.org, async tx => {
      await tx.query("set local statement_timeout='8000ms'");
      routerPid = (await tx.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid;
      return createPostgresAutomationRepository().routeEvent(tx, {
        org: t.org, eventId: randomUUID(), executionId: randomUUID(), correlationId: randomUUID(),
        channelId: t.channel, conversationId: t.conversation, eventKey: 'archive-race', input: { text: 'synthetic' },
      });
    }).then(value => ({ value }), error => ({ error }));
    try {
      // A database-observed blocking relationship, not a delay, establishes that
      // the real router reached the lock protected by the archival transaction.
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline && !blocked) {
        blocked = routerPid !== 0 && Boolean((await db.database.pool.query(
          'select 1 from pg_stat_activity where pid=$1 and $2=any(pg_blocking_pids(pid))', [routerPid, archivePid],
        )).rowCount);
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
    } finally { releaseArchive(); }
    const results = await Promise.all([archive, router]);
    expect(results.map(result => 'error' in result ? result.error : null)).toEqual([null, null]);
    expect((await db.database.pool.query('select status from automation_bindings where organization_id=$1 and channel_id=$2', [t.org, t.channel])).rows)
      .toEqual([{ status: 'DISABLED' }]);
  }, 15000);

  it.each(['bind','pause'] as const)('serializes %s after routing and preserves the admitted execution',async action=>{
    const t=await seedAttendanceTenant(db.database,false);
    await db.database.pool.query('insert into flow_features(organization_id,enabled) values($1,true)',[t.org]);
    const original=await createAutomationService({transact:db.transact}).bind(t.org,t.automation,{channelId:t.channel,version:1,expectedOwnerRevision:0});
    let admitted!:()=>void,releaseRouter!:()=>void;
    const admission=new Promise<void>(resolve=>{admitted=resolve;}),proceed=new Promise<void>(resolve=>{releaseRouter=resolve;});
    let routerPid=0,mutationPid=0;
    const router=db.transact(t.org,async tx=>{
      await tx.query("set local statement_timeout='8000ms'");
      routerPid=(await tx.query<{pid:number}>('select pg_backend_pid() pid')).rows[0]!.pid;
      const observed={query:async(sql:string,args?:unknown[])=>{
        if(sql.startsWith('insert into automation_executions')){admitted();await proceed;}
        return tx.query(sql,args);
      }} as TenantTransaction;
      return createPostgresAutomationRepository().routeEvent(observed,{
        org:t.org,eventId:randomUUID(),executionId:randomUUID(),correlationId:randomUUID(),channelId:t.channel,
        conversationId:t.conversation,eventKey:`definition-${action}`,input:{text:'synthetic'},
      });
    }).then(value=>({value}),error=>({error}));
    await admission;
    const service=createAutomationService({transact:(org,work)=>db.transact(org,async tx=>{
      await tx.query("set local statement_timeout='8000ms'");
      mutationPid=(await tx.query<{pid:number}>('select pg_backend_pid() pid')).rows[0]!.pid;
      return work(tx);
    })});
    const mutation=(action==='bind'
      ?service.bind(t.org,t.automation,{channelId:t.channel,version:1,expectedOwnerRevision:1})
      :service.setBindingStatus(t.org,original.id,{status:'PAUSED',revision:original.revision,expectedOwnerRevision:1},t.automation))
      .then(value=>({value}),error=>({error}));
    try{
      const deadline=Date.now()+5000;let blocked=false;
      while(Date.now()<deadline&&!blocked){
        blocked=mutationPid!==0&&Boolean((await db.database.pool.query(
          'select 1 from pg_stat_activity where pid=$1 and $2=any(pg_blocking_pids(pid))',[mutationPid,routerPid],
        )).rowCount);
        if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(blocked).toBe(true);
    }finally{releaseRouter();}
    const results=await Promise.all([router,mutation]);
    expect(results.map(result=>'error' in result?result.error:null)).toEqual([null,null]);
    expect((await db.database.pool.query('select status from automation_executions where organization_id=$1',[t.org])).rows).toEqual([{status:'QUEUED'}]);
    expect((await db.database.pool.query('select status from automation_bindings where id=$1',[original.id])).rows[0].status).toBe(action==='pause'?'PAUSED':'ACTIVE');
  },15000);
});
