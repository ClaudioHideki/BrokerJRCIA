import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { createGroupRemovalService } from '../../src/modules/lifecycle/group-removal-service.js';
import { createLifecycleService, withLifecyclePlatformTransaction, withLifecycleWorkerTransaction } from '../../src/modules/lifecycle/service.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';

let db: IsolatedPostgresDatabase, platform: Pool, worker: Pool, app: Pool;
let service: ReturnType<typeof createGroupRemovalService>, lifecycle: ReturnType<typeof createLifecycleService>;
let workerGroups: ReturnType<typeof createGroupRemovalService>;
const actor = randomUUID(), support = randomUUID(), reason = 'Synthetic explicit removal request';
const deprovision = vi.fn(async (_org: string, _key: string) => undefined);
let platformLifecycle:ReturnType<typeof createLifecycleService>;
beforeAll(async () => {
  const admin = requireTestDatabaseAdminUrl(); db = await createIsolatedPostgresDatabase(admin);
  await withGlobalRoleLock(admin, async () => {
    await runMigrations(db.connectionString);
  });
  await db.pool.query(`INSERT INTO platform_users(id,email,password_hash,role,mfa_seed) VALUES
    ($1,'group-remove-admin@example.test','no-login','SUPER_ADMIN','no-login'),
    ($2,'group-remove-support@example.test','no-login','SUPPORT','no-login')`, [actor, support]);
  const url = new URL(db.connectionString); url.password = ''; url.username = 'jrc_platform'; platform = new Pool({connectionString:url.toString()});
  url.username = 'jrc_lifecycle'; worker = new Pool({connectionString:url.toString()});
  url.username = 'jrc_app'; app = new Pool({connectionString:url.toString()});
  service = createGroupRemovalService({transact:work => withLifecyclePlatformTransaction(platform, work)});
  workerGroups = createGroupRemovalService({transact:work => withLifecycleWorkerTransaction(worker, work)});
  lifecycle = createLifecycleService({transact:work => withLifecycleWorkerTransaction(worker, work), deprovision});
  platformLifecycle = createLifecycleService({transact:work => withLifecyclePlatformTransaction(platform, work), deprovision});
}, 60_000);
afterAll(async () => { await platform?.end(); await worker?.end(); await app?.end(); await db?.dispose(); });

async function seedCompany(id:string,name:string){
  const client=await db.pool.connect(),owner=randomUUID();
  try {await client.query('BEGIN');
    await client.query('INSERT INTO organizations(id,name,slug) VALUES($1::uuid,$2,$1::text)',[id,name]);
    await client.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'no-login')",[owner,`${owner}@example.test`]);
    await client.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')",[id,owner]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function fixture(count = 2) {
  const id = randomUUID(); await db.pool.query('INSERT INTO economic_groups(id,name) VALUES($1,$2)', [id, `Group ${id}`]);
  const companies: {id:string;name:string}[] = [];
  for (let index = 0; index < count; index++) {
    const org = {id:randomUUID(),name:`Company ${index} ${id}`}; companies.push(org);
    await seedCompany(org.id,org.name);
    await db.pool.query('INSERT INTO economic_group_organizations(group_id,organization_id) VALUES($1,$2)', [id,org.id]);
  }
  return {id,companies};
}
async function input(group: Awaited<ReturnType<typeof fixture>>, removeGroupIfEmpty = false) {
  const preview = await service.preview(actor, {groupId:group.id,reason});
  return {groupId:group.id,expectedRevision:preview.groupRevision,previewId:preview.previewId,previewRevision:preview.previewRevision,
    selectedCompanyIds:group.companies.map(c=>c.id),confirmation:{companies:group.companies.map(c=>({id:c.id,typedName:c.name})),removeGroupIfEmpty},
    reason,idempotencyKey:randomUUID()};
}

it('requires exact operator names and current preview, with no hidden selection or child creation on rejection', async () => {
  const group = await fixture(), request = await input(group);
  await expect(service.request(actor,{...request,confirmation:{...request.confirmation,companies:[]}})).rejects.toMatchObject({status:400});
  await expect(service.request(actor,{...request,confirmation:{...request.confirmation,companies:[{id:group.companies[0]!.id,typedName:'Wrong'}]}})).rejects.toMatchObject({status:400});
  await expect(service.request(actor,{...request,confirmation:{...request.confirmation,companies:request.confirmation.companies.map((company,index)=>index?company:{...company,typedName:'Wrong'})}}))
    .rejects.toMatchObject({status:400,code:'GROUP_REMOVAL_CONFIRMATION_REQUIRED'});
  await expect(service.request(actor,{...request,selectedCompanyIds:[randomUUID()]})).rejects.toMatchObject({status:400});
  await db.pool.query('UPDATE organizations SET name=$2 WHERE id=$1',[group.companies[0]!.id,'Renamed after preview']);
  await expect(service.request(actor,request)).rejects.toMatchObject({code:'GROUP_REMOVAL_PREVIEW_CHANGED',status:409});
  expect((await db.pool.query('SELECT id FROM lifecycle_deletions WHERE organization_id=ANY($1::uuid[])',[group.companies.map(c=>c.id)])).rows).toEqual([]);
});

it('rejects expired preview, changed group revision and changed company status before creating any child',async()=>{
  const group=await fixture(1),request=await input(group);
  await db.pool.query("UPDATE group_company_removal_previews SET expires_at=now()-interval '1 second' WHERE id=$1",[request.previewId]);
  await expect(service.request(actor,request)).rejects.toMatchObject({code:'GROUP_REMOVAL_PREVIEW_CHANGED'});
  const changed=await input(group);
  await db.pool.query('UPDATE economic_groups SET revision=revision+1 WHERE id=$1',[group.id]);
  await expect(service.request(actor,changed)).rejects.toMatchObject({code:'GROUP_REMOVAL_PREVIEW_CHANGED'});
  const status=await input(group);await db.pool.query("UPDATE organizations SET status='SUSPENDED' WHERE id=$1",[group.companies[0]!.id]);
  await expect(service.request(actor,status)).rejects.toMatchObject({code:'GROUP_REMOVAL_PREVIEW_CHANGED'});
  expect((await db.pool.query('SELECT id FROM lifecycle_deletions WHERE organization_id=$1',[group.companies[0]!.id])).rows).toEqual([]);
});

it('paginates persistent group operations without exposing another group and rechecks the read actor',async()=>{
  const group=await fixture(1),other=await fixture(1),ids:string[]=[];
  for(let index=0;index<27;index++){
    const id=randomUUID();ids.push(id);
    await db.pool.query(`INSERT INTO group_company_removals(id,group_id,actor_id,idempotency_key,request_hash,preview_id,selected_company_ids,remove_group_if_empty,group_stage)
      VALUES($1,$2,$3,$4,'synthetic',$5,$6,false,'NOT_REQUESTED')`,[id,group.id,actor,randomUUID(),randomUUID(),[group.companies[0]!.id]]);
    const deletion=randomUUID(),company=randomUUID();
    await db.pool.query("INSERT INTO lifecycle_deletions(id,organization_id,kind,resource_id,actor_kind,actor_id,status) VALUES($1,$2,'ORGANIZATION',$2,'PLATFORM',$3,'COMPLETED')",[deletion,company,actor]);
    await db.pool.query('INSERT INTO group_company_removal_children(removal_id,company_id,deletion_id) VALUES($1,$2,$3)',[id,company,deletion]);
  }
  const first=await service.list(actor,group.id);expect(first.data).toHaveLength(25);expect(first.nextCursor).not.toBeNull();
  const second=await service.list(actor,group.id,first.nextCursor!);expect(second.data).toHaveLength(2);expect(second.nextCursor).toBeNull();
  expect(new Set([...first.data,...second.data].map(item=>item.operationId))).toEqual(new Set(ids));
  expect((await service.list(actor,other.id)).data).toEqual([]);
  await expect(service.list(support,group.id)).rejects.toMatchObject({status:403});
  // These are completed historical records, not synthetic work for later tests.
  await db.pool.query("UPDATE group_company_removals SET status='COMPLETED' WHERE group_id=$1",[group.id]);
});

it('persists unique children and supplied confirmation, survives reload, and rejects changed idempotent requests', async () => {
  const group=await fixture(),request=await input(group,true);
  const [one,two]=await Promise.all([service.request(actor,request),service.request(actor,request)]);
  expect(one.operationId).toBe(two.operationId); expect(one.companies).toHaveLength(2);
  expect(new Set(one.companies.map(c=>c.operationId)).size).toBe(2);
  await expect(service.request(actor,{...request,confirmation:{...request.confirmation,removeGroupIfEmpty:false}}))
    .rejects.toMatchObject({code:'GROUP_REMOVAL_IDEMPOTENCY_CONFLICT',status:409});
  expect((await service.get(actor,one.operationId)).companies).toEqual(one.companies);
  expect((await db.pool.query('SELECT confirmation FROM group_company_removals WHERE id=$1',[one.operationId])).rows[0].confirmation).toEqual(request.confirmation);
  expect(await lifecycle.processOne()).toBe(true);
  const partial=await service.get(actor,one.operationId);
  expect(partial.status).toBe('PARTIAL'); expect(partial.companies.filter(c=>c.status==='COMPLETED')).toHaveLength(1);
  const completed=partial.companies.find(c=>c.status==='COMPLETED')!;
  const stored=(await db.pool.query('SELECT snapshot,confirmation FROM group_company_removals WHERE id=$1',[one.operationId])).rows[0];
  expect(JSON.stringify(stored)).not.toContain(completed.id);
  // A recreated service/worker resumes the same persisted child set after a restart.
  const restarted=createLifecycleService({transact:work=>withLifecycleWorkerTransaction(worker,work),deprovision});
  expect(await restarted.processOne()).toBe(true); await workerGroups.processOne();
  expect(await service.get(actor,one.operationId)).toMatchObject({status:'COMPLETED',groupStage:'REMOVED'});
  expect((await db.pool.query('SELECT id FROM economic_groups WHERE id=$1',[group.id])).rows).toEqual([]);
});

async function qrFixture(){
  const group=await fixture(1),org=group.companies[0]!,account=randomUUID(),instance=randomUUID();
  await db.pool.query("INSERT INTO provider_accounts(id,organization_id,provider,name) VALUES($1,$2,'BAILEYS','QR test')",[account,org.id]);
  await db.pool.query("INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,$3,'QR synthetic',$4,'DISCONNECTED')",[instance,org.id,account,`qr-${instance}`]);
  const request=await platformLifecycle.requestOrganization(org.id,org.name,reason,actor);
  return {org,instance,request};
}
it('records dispatch before network and does not repeat an unknown removal after an expired worker lease',async()=>{
  const item=await qrFixture();let finish!:()=>void;
  const firstProvider=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;})),secondProvider=vi.fn(async()=>undefined);
  const first=createLifecycleService({transact:work=>withLifecycleWorkerTransaction(worker,work),deprovision:firstProvider});
  const second=createLifecycleService({transact:work=>withLifecycleWorkerTransaction(worker,work),deprovision:secondProvider});
  const running=first.processOne();
  await vi.waitFor(()=>expect(firstProvider).toHaveBeenCalledTimes(1));
  try {
    expect((await db.pool.query('SELECT status FROM lifecycle_cleanup_items WHERE deletion_id=$1',[item.request.operationId])).rows[0].status).toBe('IN_FLIGHT');
    await db.pool.query("UPDATE lifecycle_deletions SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[item.request.operationId]);
    expect(await second.processOne()).toBe(true); expect(secondProvider).not.toHaveBeenCalled();
    expect(await platformLifecycle.status(item.org.id,item.org.id,item.request.operationId)).toMatchObject({status:'ACTION_REQUIRED',errorCode:'EVOLUTION_CLEANUP_UNVERIFIED'});
  } finally {finish();await running;}
});

it('reconciles an uncertain external result by lookup only, then purges after verified absence',async()=>{
  const item=await qrFixture();
  const failing=createLifecycleService({transact:work=>withLifecycleWorkerTransaction(worker,work),deprovision:async()=>{throw new Error('timeout');}});
  await failing.processOne();
  await platformLifecycle.requestReconciliation(item.org.id,item.org.id,item.request.operationId,reason,'PLATFORM',actor);
  const lookup=vi.fn(async()=>false),remove=vi.fn(async()=>undefined);
  const recovering=createLifecycleService({transact:work=>withLifecycleWorkerTransaction(worker,work),deprovision:remove,instanceExists:lookup});
  await recovering.processOne();
  expect(lookup).toHaveBeenCalledOnce();expect(remove).not.toHaveBeenCalled();
  expect(await platformLifecycle.status(item.org.id,item.org.id,item.request.operationId)).toMatchObject({status:'COMPLETED'});
});

it('requires a new explicit deletion after reconciliation proves the instance still exists',async()=>{
  const item=await qrFixture(),lookup=vi.fn(async()=>true),remove=vi.fn(async()=>undefined);
  const failing=createLifecycleService({transact:work=>withLifecycleWorkerTransaction(worker,work),deprovision:async()=>{throw new Error('timeout');}});
  await failing.processOne();
  await platformLifecycle.requestReconciliation(item.org.id,item.org.id,item.request.operationId,reason,'PLATFORM',actor);
  const recovering=createLifecycleService({transact:work=>withLifecycleWorkerTransaction(worker,work),deprovision:remove,instanceExists:lookup});
  await recovering.processOne();expect(remove).not.toHaveBeenCalled();
  expect(await platformLifecycle.status(item.org.id,item.org.id,item.request.operationId)).toMatchObject({status:'ACTION_REQUIRED',errorCode:'EVOLUTION_INSTANCE_STILL_PRESENT'});
  await platformLifecycle.requestOrganization(item.org.id,item.org.name,reason,actor);
  await recovering.processOne();expect(remove).toHaveBeenCalledOnce();
  expect(await platformLifecycle.status(item.org.id,item.org.id,item.request.operationId)).toMatchObject({status:'COMPLETED'});
});

it('does not let a second worker dispatch an active lease and never repeats confirmed cleanup',async()=>{
  const item=await qrFixture();let finish!:()=>void;
  const remove=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
  const first=createLifecycleService({transact:work=>withLifecycleWorkerTransaction(worker,work),deprovision:remove});
  const running=first.processOne();await vi.waitFor(()=>expect(remove).toHaveBeenCalledTimes(1));
  try{expect(await lifecycle.processOne()).toBe(false);}finally{finish();await running;}
  expect(await platformLifecycle.status(item.org.id,item.org.id,item.request.operationId)).toMatchObject({status:'COMPLETED'});
  expect(await first.processOne()).toBe(false);expect(remove).toHaveBeenCalledOnce();
});

it('rechecks authorization after a remote lookup and denies reconciliation for another resource',async()=>{
  const item=await qrFixture();
  const failing=createLifecycleService({transact:work=>withLifecycleWorkerTransaction(worker,work),deprovision:async()=>{throw new Error('timeout');}});
  await failing.processOne();
  await expect(platformLifecycle.requestReconciliation(randomUUID(),item.org.id,item.request.operationId,reason,'PLATFORM',actor)).rejects.toMatchObject({status:404});
  await expect(platformLifecycle.requestReconciliation(item.org.id,item.org.id,item.request.operationId,reason,'PLATFORM',support)).rejects.toMatchObject({status:403});
  await platformLifecycle.requestReconciliation(item.org.id,item.org.id,item.request.operationId,reason,'PLATFORM',actor);
  const recovering=createLifecycleService({transact:work=>withLifecycleWorkerTransaction(worker,work),deprovision:vi.fn(),instanceExists:async()=>{
    await db.pool.query('UPDATE platform_users SET active=false WHERE id=$1',[actor]);return false;
  }});
  try{await recovering.processOne();}finally{await db.pool.query('UPDATE platform_users SET active=true WHERE id=$1',[actor]);}
  expect(await platformLifecycle.status(item.org.id,item.org.id,item.request.operationId)).toMatchObject({status:'ACTION_REQUIRED',errorCode:'LIFECYCLE_ACTOR_REVOKED'});
  expect((await db.pool.query('SELECT id FROM organizations WHERE id=$1',[item.org.id])).rowCount).toBe(1);
});

it('preserves a company associated after the request and reports the blocked final group step', async () => {
  const group=await fixture(),operation=await service.request(actor,await input(group,true));
  const later=randomUUID(); await seedCompany(later,'Later company');
  await db.pool.query('INSERT INTO economic_group_organizations(group_id,organization_id) VALUES($1,$2)',[group.id,later]);
  await db.pool.query('UPDATE economic_groups SET revision=revision+1 WHERE id=$1',[group.id]);
  await lifecycle.processOne(); await lifecycle.processOne(); await workerGroups.processOne();
  expect(await service.get(actor,operation.operationId)).toMatchObject({status:'ACTION_REQUIRED',groupStage:'PRESERVED',errorCode:'GROUP_HAS_REMAINING_COMPANIES'});
  expect((await db.pool.query('SELECT id FROM organizations WHERE id=$1',[later])).rowCount).toBe(1);
  expect((await db.pool.query('SELECT id FROM economic_groups WHERE id=$1',[group.id])).rowCount).toBe(1);
});

it('processes only explicit selection and preserves the group by default', async () => {
  const group=await fixture(),request=await input(group);
  request.selectedCompanyIds=[group.companies[0]!.id]; request.confirmation.companies=[request.confirmation.companies[0]!];
  const operation=await service.request(actor,request); await lifecycle.processOne(); await workerGroups.processOne();
  expect(await service.get(actor,operation.operationId)).toMatchObject({status:'COMPLETED',groupStage:'NOT_REQUESTED'});
  expect((await db.pool.query('SELECT organization_id FROM economic_group_organizations WHERE group_id=$1',[group.id])).rows).toEqual([{organization_id:group.companies[1]!.id}]);
});

it('denies SUPPORT, revoked actors and tenant connections before new operations, without table write or purge privileges', async () => {
  const group=await fixture(),request=await input(group);
  await expect(service.preview(support,{groupId:group.id,reason})).rejects.toMatchObject({status:403});
  await expect(service.request(support,request)).rejects.toMatchObject({status:403});
  await expect(app.query('SELECT * FROM group_company_removals')).rejects.toMatchObject({code:'42501'});
  await expect(platform.query("UPDATE group_company_removals SET status='COMPLETED'")).rejects.toMatchObject({code:'42501'});
  await expect(platform.query('SELECT public.group_removal_process_one()')).rejects.toMatchObject({code:'42501'});
  const operation=await service.request(actor,request);
  await db.pool.query('UPDATE platform_users SET active=false WHERE id=$1',[actor]);
  try {
    await expect(service.get(actor,operation.operationId)).rejects.toMatchObject({status:403});
    await lifecycle.processOne(); await lifecycle.processOne();
  } finally {await db.pool.query('UPDATE platform_users SET active=true WHERE id=$1',[actor]);}
  expect((await service.get(actor,operation.operationId)).status).toBe('ACTION_REQUIRED');
  expect((await db.pool.query('SELECT id FROM organizations WHERE id=ANY($1::uuid[])',[group.companies.map(c=>c.id)])).rowCount).toBe(2);
});
