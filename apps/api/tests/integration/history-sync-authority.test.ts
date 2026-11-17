import { createHmac,randomUUID } from 'node:crypto';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { attendanceDatabase,seedAttendanceTenant } from './helpers/attendance.js';
import { createEvolutionFleetRuntime } from '../../src/modules/evolution-fleet/runtime.js';
import { createHistoryRuntimeAuthority } from '../../src/modules/history-sync/authority.js';
import { historyLogicalOwnerFingerprint } from '../../src/modules/history-sync/contract.js';

let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();},60000);
afterAll(async()=>{await db?.dispose();});
const signingKey='synthetic-history-authority-key-for-isolated-tests';
async function setup(){
  const tenant=await seedAttendanceTenant(db.database),instance=randomUUID();
  const instanceKey=`synthetic-${instance}`,session=randomUUID(),owner='1'.repeat(11);
  const fleet=createEvolutionFleetRuntime({EVOLUTION_BASE_URL:'https://engine.example.test',EVOLUTION_API_KEY:'synthetic-engine-key',QR_WEBHOOK_SIGNING_KEY:signingKey},db.transact);
  await db.database.pool.query(`UPDATE provider_accounts SET provider='BAILEYS' WHERE organization_id=$1`,[tenant.org]);
  await db.database.pool.query(`INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status)
    SELECT $1,organization_id,provider_account_id,'Synthetic owned channel',$2,'CONNECTED' FROM messaging_channels WHERE id=$3`,[instance,instanceKey,tenant.channel]);
  await db.database.pool.query(`UPDATE messaging_channels SET provider='BAILEYS',instance_id=$2,phone_number_id=NULL,waba_id=NULL WHERE id=$1`,[tenant.channel,instance]);
  const engine=await fleet.capture(tenant.org,instanceKey);
  const fingerprint=createHmac('sha256',signingKey).update(JSON.stringify(['qr-engine:v1',engine.engineId,engine.generation,engine.destinationFingerprint,engine.traditional])).digest('hex');
  const ownerFingerprint=createHmac('sha256',signingKey).update(`qr-identity:v1:${tenant.org}:${tenant.channel}:${instanceKey}:${owner}`).digest('hex');
  const identity=randomUUID();
  await db.database.pool.query(`INSERT INTO qr_identity_scopes(organization_id,channel_id,instance_id,scope_id,owner_fingerprint,upstream_instance_key,binding_fingerprint)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[tenant.org,tenant.channel,instance,identity,ownerFingerprint,instanceKey,fingerprint]);
  const authority=createHistoryRuntimeAuthority({fleet,signingKey});
  const resolve=(phone:string|null=owner)=>db.transact(tenant.org,tx=>authority.resolve(tx,tenant.org,tenant.channel,session,phone));
  return{...tenant,instance,instanceKey,session,owner,identity,fingerprint,authority,resolve};
}

it('derives the scope from current channel, fleet and verified owner; same owner resolves one logical identity',async()=>{
  const f=await setup(),first=await f.resolve(),second=await f.resolve();
  expect(first).toMatchObject({organizationId:f.org,channelId:f.channel,instanceId:f.instance,engineId:'legacy',engineGeneration:1,
    sessionGeneration:f.session,bindingFingerprint:f.fingerprint,identityScopeId:f.identity,
    ownerFingerprint:historyLogicalOwnerFingerprint(signingKey,f.org,f.channel,f.owner)});
  expect(second).toEqual(first);
  await db.transact(f.org,tx=>f.authority.assertCurrentScope(tx,first));
  expect((await db.database.pool.query('SELECT count(*)::int AS n FROM history_account_identities WHERE channel_id=$1',[f.channel])).rows[0].n).toBe(1);
});

it('never promotes a supplied owner which disagrees with the authenticated current QR identity',async()=>{
  const f=await setup();
  await expect(f.resolve('2'.repeat(11))).rejects.toThrow('HISTORY_SYNC_OWNER_UNVERIFIED');
  expect((await db.database.pool.query('SELECT count(*)::int AS n FROM history_account_identities WHERE channel_id=$1',[f.channel])).rows[0].n).toBe(0);
  const provisional=await f.resolve(null);
  expect(provisional).toMatchObject({identityScopeId:null,historyAccountIdentity:null,ownerFingerprint:null});
});

it('rejects stale identity and binding after a reconnect to another owner; tenant context cannot select another channel',async()=>{
  const f=await setup(),scope=await f.resolve();
  const other=await seedAttendanceTenant(db.database);
  await expect(db.transact(other.org,tx=>f.authority.resolve(tx,other.org,f.channel,f.session,null))).rejects.toThrow();
  await db.database.pool.query('UPDATE qr_identity_scopes SET scope_id=$2,owner_fingerprint=$3 WHERE channel_id=$1',[f.channel,randomUUID(),'e'.repeat(64)]);
  await expect(db.transact(f.org,tx=>f.authority.assertCurrentScope(tx,scope))).rejects.toThrow('HISTORY_SYNC_SCOPE_CHANGED');
  await db.database.pool.query('UPDATE qr_identity_scopes SET scope_id=$2,owner_fingerprint=$3,binding_fingerprint=$4 WHERE channel_id=$1',[f.channel,f.identity,'a'.repeat(64),'c'.repeat(64)]);
  await expect(f.resolve(null)).rejects.toThrow('HISTORY_SYNC_BINDING_CHANGED');
});

it('holds current identity and channel fences until transaction COMMIT',async()=>{
  const f=await setup(),scope=await f.resolve();
  const contender=await db.database.pool.connect();
  try{
    await db.transact(f.org,async tx=>{
      await f.authority.assertCurrentScope(tx,scope);
      await contender.query('BEGIN');await contender.query("SET LOCAL lock_timeout='150ms'");
      await expect(contender.query('UPDATE qr_identity_scopes SET scope_id=$2 WHERE channel_id=$1',[f.channel,randomUUID()])).rejects.toMatchObject({code:'55P03'});
      await contender.query('ROLLBACK');
    });
    await contender.query('UPDATE qr_identity_scopes SET scope_id=$2 WHERE channel_id=$1',[f.channel,randomUUID()]);
    await expect(db.transact(f.org,tx=>f.authority.assertCurrentScope(tx,scope))).rejects.toThrow('HISTORY_SYNC_SCOPE_CHANGED');
  }finally{await contender.query('ROLLBACK').catch(()=>{});contender.release();}
});
