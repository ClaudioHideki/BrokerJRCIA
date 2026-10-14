import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';import {Pool} from 'pg';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {connectionStringForRole} from './helpers/task7.js';
import {createLifecycleService,withLifecyclePlatformTransaction,withLifecycleWorkerTransaction} from '../../src/modules/lifecycle/service.js';
import {probeRequiredRuntimeSchema} from '../../src/db/runtime-schema.js';
import {ensureQrChannel} from '../../src/modules/messaging/qr-service.js';
import {createIntegrationSecrets} from '../../src/modules/integrations/secrets.js';
import {createFlowDelegationService} from '../../src/modules/flows/delegation/service.js';import {createNativeRegistrationService} from '../../src/modules/flows/delegation/registration/service.js';import {createNativeRegistrationVault} from '../../src/modules/flows/delegation/registration/core.js';
import {createNativeInstallationService} from '../../src/modules/flows/delegation/installation/service.js';
const key=Buffer.alloc(32,17).toString('base64'),keyring=JSON.stringify({1:key}),secret=createIntegrationSecrets(key),hash=(value:string)=>createHash('sha256').update(value).digest('hex');
let db:Awaited<ReturnType<typeof attendanceDatabase>>,authPool:Pool;
beforeAll(async()=>{db=await attendanceDatabase();authPool=new Pool({connectionString:connectionStringForRole(db.database.connectionString,'jrc_auth')});},180000);
afterAll(async()=>{await authPool?.end();await db?.dispose();});
async function fixture(){
 const t=await seedAttendanceTenant(db.database),actor=(await db.database.pool.query('SELECT user_id FROM memberships WHERE organization_id=$1',[t.org])).rows[0].user_id;
 const authVersion=(await db.database.pool.query('SELECT auth_version FROM users WHERE id=$1',[actor])).rows[0].auth_version;
 const backup=randomUUID();await db.database.pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'synthetic')",[backup,`${backup}@example.test`]);await db.database.pool.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')",[t.org,backup]);
 await db.database.pool.query("UPDATE chatwoot_accounts SET encrypted_token=$2 WHERE organization_id=$1",[t.org,secret.encrypt(`${t.org}:chatwoot-account`,'synthetic-only')]);
 await db.database.pool.query("UPDATE chatwoot_destinations SET approval_status='APPROVED' WHERE organization_id=$1",[t.org]);
 await db.database.pool.query('INSERT INTO flow_features(organization_id,enabled) VALUES($1,true) ON CONFLICT(organization_id) DO UPDATE SET enabled=true',[t.org]);
 const channel=await db.transact(t.org,async tx=>{const provider=(await tx.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','Synthetic QR') RETURNING id",[t.org])).rows[0].id;
  const instance=(await tx.query("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'Synthetic QR',$3,'CONNECTED') RETURNING id",[t.org,provider,'synthetic-'+randomUUID()])).rows[0].id;return (await ensureQrChannel(tx,t.org,instance)).id;});
 const integration=randomUUID();await db.database.pool.query("INSERT INTO chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status) VALUES($1,$2,$3,19,'Synthetic only','READY')",[integration,t.org,channel]);
 const principal={organizationId:t.org,actorId:actor,authVersion},service=createFlowDelegationService({transact:db.transact,automation:{enabled:true}});
 const credential=await service.issueNativeCredential(principal,{scopes:['flow:read','flow:edit','flow:publish','flow:bind'],expiresInSeconds:86400}),access={organizationId:t.org,token:credential.token};
 // Controlled collaborator exercises Broker post-I/O transactions; this is not
 // an installed-host/image proof or a Rails authentication acceptance claim.
 const registration=createNativeRegistrationService({transact:db.transact,authority:service.nativeRegistrationAuthority,authorizeAdministrator:service.nativeRegistrationAdministrator,vault:createNativeRegistrationVault(keyring),verifyHost:async request=>({...request,authorized:true})});
 const challenge=await registration.issue(principal,{credentialId:credential.id,expectedCredentialRevision:1,expectedDestinationRevision:1,expectedAccountCredentialVersion:1,integrationIds:[integration]});
 const registered=await registration.complete(access,challenge.transferNonce,{challengeId:challenge.challengeId,callbackCredential:'r'.repeat(43)});
 let callback:(request:any)=>Promise<unknown>=async request=>({...request,authorized:true}),calls=0;
 const installations=createNativeInstallationService({transact:db.transact,service,keyring,verifyHost:async(request)=>{calls++;return callback(request);}});
 const grant=await installations.issue(principal,{registrationId:registered.id,expectedRegistrationRevision:1,expectedCredentialRevision:1,expectedDestinationRevision:1,expectedAccountCredentialVersion:1});
 const claim={transferNonce:grant.transferNonce,operationNonce:randomUUID(),installationCallbackCredential:'i'.repeat(43)};
 return {...t,channel,integration,principal,service,credential,registered,access,grant,claim,installations,callback:(next:typeof callback)=>{callback=next;},calls:()=>calls};
}
async function claim(t:Awaited<ReturnType<typeof fixture>>){return t.installations.claim(t.access,t.grant.grantId,t.claim) as Promise<{id:string;token:string;generation:number;expiresAt:string}>;}
async function renewal(t:Awaited<ReturnType<typeof fixture>>){await db.database.pool.query("UPDATE flow_delegation_credentials SET expires_at=clock_timestamp()+interval '1 hour' WHERE organization_id=$1 AND id=$2",[t.org,t.credential.id]);return {operationNonce:randomUUID(),expectedGeneration:1,expectedCredentialId:t.credential.id,expectedCredentialRevision:1,nativeCallbackCredential:'n'.repeat(43)};}
it('uses grant-only SQL authority, tenantRLS and exact30day/5minute issuance ceilings',async()=>{
 const t=await fixture(),response=await claim(t),digest=hash(response.token);
 expect((await authPool.query('SELECT resolve_flow_installation_grant($1) AS org',[digest])).rows[0].org).toBe(t.org);
 expect((await authPool.query('SELECT resolve_flow_delegation_credential($1) AS org,resolve_flow_delegation_session($1) AS session',[digest])).rows[0]).toEqual({org:null,session:null});
 const g=(await db.database.pool.query("SELECT expires_at=created_at+interval '30 days' AS lifetime,transfer_expires_at<=created_at+interval '5 minutes' AS transfer FROM flow_native_installation_grants WHERE id=$1",[response.id])).rows[0];expect(g).toEqual({lifetime:true,transfer:true});
 const foreign=await seedAttendanceTenant(db.database);expect(await db.transact(foreign.org,tx=>tx.query('SELECT id FROM flow_native_installation_grants WHERE id=$1',[response.id]))).toMatchObject({rowCount:0});
 await expect(db.transact(t.org,tx=>tx.query('SELECT resolve_flow_installation_grant($1)',[digest]))).rejects.toMatchObject({code:'42501'});
});
it('recovers only the exact claimed nonce/callback and seals the response without repeating proof I/O',async()=>{
 const t=await fixture(),response=await claim(t);expect(await claim(t)).toEqual(response);expect(t.calls()).toBe(1);
 await expect(t.installations.claim(t.access,t.grant.grantId,{...t.claim,installationCallbackCredential:'j'.repeat(43)})).rejects.toMatchObject({code:'FLOW_INSTALLATION_REPLAY_CHANGED'});
 const op=(await db.database.pool.query('SELECT response_ciphertext,state FROM flow_native_installation_operations WHERE grant_id=$1',[t.grant.grantId])).rows[0];expect(op.state).toBe('COMMITTED');expect(op.response_ciphertext).not.toContain(response.token);
});
it('serializes two claim operations by the same grant generation while a callback is in flight',async()=>{
 const t=await fixture();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
 t.callback(async request=>{entered();await gate;return {...request,authorized:true};});const first=claim(t);await started;
 await expect(t.installations.claim(t.access,t.grant.grantId,{...t.claim,operationNonce:randomUUID()})).rejects.toMatchObject({code:'FLOW_INSTALLATION_IN_PROGRESS'});release();await first;
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM flow_native_installation_operations WHERE grant_id=$1',[t.grant.grantId])).rows[0].n).toBe(1);
});
it('two renewal workers create one generation and exact response recovery never creates another credential',async()=>{
 const t=await fixture(),installed=await claim(t),input=await renewal(t),access={organizationId:t.org,token:installed.token};let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
 t.callback(async request=>{entered();await gate;return {...request,authorized:true};});const first=t.installations.renew(access,installed.id,input);await started;
 await expect(t.installations.renew(access,installed.id,input)).rejects.toMatchObject({code:'FLOW_INSTALLATION_IN_PROGRESS'});release();const result=await first;
 expect(result.generation).toBe(2);expect(await t.installations.renew(access,installed.id,input)).toEqual(result);
 const rows=(await db.database.pool.query('SELECT id,revoked_at FROM flow_delegation_credentials WHERE organization_id=$1',[t.org])).rows;expect(rows.filter(row=>!row.revoked_at)).toHaveLength(1);
 const g=(await db.database.pool.query("SELECT generation FROM flow_native_installation_grants WHERE id=$1",[installed.id])).rows[0];expect(g.generation).toBe(2);
});
it('denies a role change during callback and persists no grant token or activation',async()=>{
 const t=await fixture();t.callback(async request=>{await db.database.pool.query("UPDATE memberships SET role='VIEWER' WHERE organization_id=$1 AND user_id=$2",[t.org,t.principal.actorId]);return {...request,authorized:true};});
 await expect(claim(t)).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
 expect((await db.database.pool.query('SELECT state,token_hash,host_callback_ciphertext FROM flow_native_installation_grants WHERE id=$1',[t.grant.grantId])).rows[0]).toEqual({state:'PENDING',token_hash:null,host_callback_ciphertext:null});
});
it('denies mapping/destination revision changes after callback',async()=>{
 const t=await fixture();t.callback(async request=>{await db.database.pool.query('UPDATE chatwoot_destinations SET revision=revision+1 WHERE organization_id=$1',[t.org]);return {...request,authorized:true};});
 await expect(claim(t)).rejects.toMatchObject({code:'FLOW_CONTEXT_CHANGED'});
 expect((await db.database.pool.query('SELECT token_hash FROM flow_native_installation_grants WHERE id=$1',[t.grant.grantId])).rows[0].token_hash).toBeNull();
});
it('keeps uncertain callback operations durable and revokes every current authority/cipher without deleting tombstones',async()=>{
 const t=await fixture(),installed=await claim(t),input=await renewal(t);t.callback(async()=>{throw new Error('controlled response loss');});
 await expect(t.installations.renew({organizationId:t.org,token:installed.token},installed.id,input)).rejects.toMatchObject({code:'FLOW_INSTALLATION_HOST_UNAVAILABLE'});
 expect((await db.database.pool.query("SELECT state FROM flow_native_installation_operations WHERE grant_id=$1 AND kind='RENEW'",[installed.id])).rows[0].state).toBe('UNKNOWN');
 await t.installations.revokeAdministrative(t.principal,installed.id);
 expect((await db.database.pool.query('SELECT state,token_hash,host_callback_ciphertext FROM flow_native_installation_grants WHERE id=$1',[installed.id])).rows[0]).toEqual({state:'REVOKED',token_hash:null,host_callback_ciphertext:null});
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM flow_native_installation_operations WHERE grant_id=$1 AND response_ciphertext IS NOT NULL',[installed.id])).rows[0].n).toBe(0);
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM flow_native_installation_operations WHERE grant_id=$1',[installed.id])).rows[0].n).toBe(2);
 expect((await authPool.query('SELECT resolve_flow_installation_grant($1) AS org',[hash(installed.token)])).rows[0].org).toBeNull();
});
it('renews a historical expired credential under a still-live grant with a new24hour row and revokes the prior generation',async()=>{
 const t=await fixture(),installed=await claim(t);
 await db.database.pool.query("UPDATE flow_delegation_credentials SET created_at=clock_timestamp()-interval '12 hours',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[t.credential.id]);
 const input={operationNonce:randomUUID(),expectedGeneration:1,expectedCredentialId:t.credential.id,expectedCredentialRevision:1,nativeCallbackCredential:'x'.repeat(43)};
 const result=await t.installations.renew({organizationId:t.org,token:installed.token},installed.id,input);
 expect(result.credential.id).not.toBe(t.credential.id);expect(result.registration.id).not.toBe(t.registered.id);
 const current=(await db.database.pool.query("SELECT c.expires_at<=g.expires_at AS grant_bound,c.expires_at<=clock_timestamp()+interval '24 hours' AS daily_bound FROM flow_native_installation_grants g JOIN flow_delegation_credentials c ON c.organization_id=g.organization_id AND c.id=g.current_credential_id WHERE g.id=$1",[installed.id])).rows[0];expect(current).toEqual({grant_bound:true,daily_bound:true});
 expect((await db.database.pool.query('SELECT revoked_at IS NOT NULL AS revoked FROM flow_delegation_credentials WHERE id=$1',[t.credential.id])).rows[0].revoked).toBe(true);
});
it('recovers a lost native reduction response only by the exact bounded reduce-only receipt',async()=>{
 const t=await fixture(),installed=await claim(t),access={organizationId:t.org,token:installed.token},input={expectedGeneration:1,operationNonce:randomUUID()};
 expect(await t.installations.revokeNative(access,installed.id,input)).toEqual({revoked:true});
 expect(await t.installations.revokeNative(access,installed.id,input)).toEqual({revoked:true});
 const receipt=hash(JSON.stringify({kind:'REVOKE',grantId:installed.id,grantDigest:hash(installed.token),...input}));
 expect((await authPool.query('SELECT resolve_flow_installation_reduction($1) AS org',[receipt])).rows[0].org).toBe(t.org);
 expect((await authPool.query('SELECT resolve_flow_installation_grant($1) AS org,resolve_flow_delegation_credential($1) AS credential,resolve_flow_delegation_session($1) AS session',[hash(installed.token)])).rows[0]).toEqual({org:null,credential:null,session:null});
 await expect(t.installations.revokeNative(access,installed.id,{...input,expectedGeneration:2})).rejects.toMatchObject({code:'FLOW_INSTALLATION_REPLAY_CHANGED'});
});
it('uses SQL expiry after callback and cannot claim an expired valid historical grant',async()=>{
 const t=await fixture(),id=randomUUID(),nonce='z'.repeat(43);
 // A short-lived valid SQL boundary fixture exercises expiry without modifying
 // immutable approval fields or mocking the PostgreSQL clock.
 await db.database.pool.query(`WITH moment AS MATERIALIZED(SELECT clock_timestamp() AS now) INSERT INTO flow_native_installation_grants(organization_id,id,registration_id,generation,tuple,tuple_digest,destination_origin,account_id,destination_revision,account_credential_version,created_by,issuer_auth_version,transfer_nonce_hash,transfer_expires_at,expires_at,current_credential_id,current_registration_id,created_at)
  SELECT organization_id,$2,registration_id,generation,tuple,tuple_digest,destination_origin,account_id,destination_revision,account_credential_version,created_by,issuer_auth_version,$3,moment.now+interval '5 minutes',moment.now+interval '2 seconds',current_credential_id,current_registration_id,moment.now FROM flow_native_installation_grants CROSS JOIN moment WHERE id=$1`,[t.grant.grantId,id,hash(nonce)]);
 await db.database.pool.query('INSERT INTO flow_native_installation_targets SELECT organization_id,$2,integration_id,channel_id,inbox_id,transport,provider FROM flow_native_installation_targets WHERE grant_id=$1',[t.grant.grantId,id]);
 t.callback(async request=>{const stop=Date.now()+5000;while(Date.now()<stop){if((await db.database.pool.query('SELECT expires_at<=clock_timestamp() AS expired FROM flow_native_installation_grants WHERE id=$1',[id])).rows[0].expired)return {...request,authorized:true};await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('SQL expiry barrier not observed');});
 await expect(t.installations.claim(t.access,id,{...t.claim,transferNonce:nonce})).rejects.toMatchObject({code:'FLOW_INSTALLATION_NOT_FOUND'});
 expect((await db.database.pool.query('SELECT state,token_hash,host_callback_ciphertext FROM flow_native_installation_grants WHERE id=$1',[id])).rows[0]).toEqual({state:'PENDING',token_hash:null,host_callback_ciphertext:null});
});

const nativeLifecycleTables = [
  'flow_native_registration_challenges', 'flow_native_registration_targets',
  'flow_native_registrations', 'flow_native_installation_grants',
  'flow_native_installation_operations', 'flow_native_installation_targets',
] as const;

async function nativeLifecycleFixture() {
  const actor = randomUUID();
  await db.database.pool.query(
    "INSERT INTO platform_users(id,email,password_hash,role,mfa_seed) VALUES($1,$2,'synthetic','SUPER_ADMIN','synthetic')",
    [actor, `native-lifecycle-${actor}@example.test`],
  );
  const platform = new Pool({connectionString:connectionStringForRole(db.database.connectionString, 'jrc_platform')});
  const worker = new Pool({connectionString:connectionStringForRole(db.database.connectionString, 'jrc_lifecycle')});
  return {
    actor, worker,
    platform: createLifecycleService({
      transact:work => withLifecyclePlatformTransaction(platform, work),
      deprovision:async () => undefined,
    }),
    service: createLifecycleService({
      transact:work => withLifecycleWorkerTransaction(worker, work),
      deprovision:async () => undefined,
    }),
    dispose:async () => { await platform.end(); await worker.end(); },
  };
}

async function nativeRows(org:string) {
  const rows:Record<string,unknown[]> = {};
  for (const table of nativeLifecycleTables) {
    rows[table] = (await db.database.pool.query(
      `SELECT to_jsonb(t) AS value FROM ${table} t WHERE organization_id=$1 ORDER BY to_jsonb(t)::text`, [org],
    )).rows.map(row => row.value);
  }
  return rows;
}

it('purges committed native challenge and registration cycles only for the selected company', async () => {
  const a = await fixture(), b = await fixture();
  await claim(a); await claim(b);
  await db.database.pool.query(
    "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OPERATOR')",
    [b.org, a.principal.actorId],
  );
  const beforeA = await nativeRows(a.org), beforeB = await nativeRows(b.org);
  for (const table of nativeLifecycleTables) expect(beforeA[table]!.length).toBeGreaterThan(0);
  const lifecycle = await nativeLifecycleFixture();
  try {
    const requested = await lifecycle.platform.requestOrganization(a.org, 'Attendance', 'Synthetic native lifecycle regression', lifecycle.actor);
    expect(await lifecycle.service.processOne()).toBe(true);
    expect(await lifecycle.platform.status(a.org, a.org, requested.operationId)).toMatchObject({status:'COMPLETED', errorCode:null});
    for (const rows of Object.values(await nativeRows(a.org))) expect(rows).toEqual([]);
    expect(await nativeRows(b.org)).toEqual(beforeB);
    expect((await db.database.pool.query('SELECT id FROM organizations WHERE id=$1', [a.org])).rowCount).toBe(0);
    expect((await db.database.pool.query('SELECT id FROM organizations WHERE id=$1', [b.org])).rowCount).toBe(1);
    expect((await db.database.pool.query('SELECT id FROM users WHERE id=$1', [a.principal.actorId])).rowCount).toBe(1);
    expect((await db.database.pool.query(
      'SELECT organization_id FROM memberships WHERE user_id=$1 ORDER BY organization_id', [a.principal.actorId],
    )).rows).toEqual([{organization_id:b.org}]);
  } finally { await lifecycle.dispose(); }
});

it('still rejects a cross-company registration reference at commit when the cycle FK is deferred', async () => {
  const a = await fixture(), b = await fixture();
  const client = await db.database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE jrc_migrator');
    await client.query('SET CONSTRAINTS flow_native_challenge_registration_fk DEFERRED');
    expect((await client.query(
      'UPDATE flow_native_registration_challenges SET registration_id=$3 WHERE organization_id=$1 AND registration_id=$2',
      [a.org, a.registered.id, b.registered.id],
    )).rowCount).toBe(1);
    await expect(client.query('COMMIT')).rejects.toMatchObject({code:'23503', constraint:'flow_native_challenge_registration_fk'});
  } finally { await client.query('ROLLBACK'); client.release(); }
  expect((await db.database.pool.query(
    'SELECT registration_id FROM flow_native_registration_challenges WHERE organization_id=$1 AND registration_id=$2',
    [a.org, a.registered.id],
  )).rowCount).toBe(1);
  expect((await db.database.pool.query('SELECT id FROM flow_native_registrations WHERE organization_id=$1 AND id=$2', [b.org, b.registered.id])).rowCount).toBe(1);
});

it.each(['flow_native_registration_targets', 'flow_native_installation_targets'] as const)(
  'keeps %s immutable to the actual app role', async table => {
    const t = await fixture();
    expect((await db.transact(t.org, tx => tx.query(
      `SELECT inbox_id FROM ${table} WHERE organization_id=$1`, [t.org],
    ))).rowCount).toBeGreaterThan(0);
    await expect(db.transact(t.org, tx => tx.query(
      `UPDATE ${table} SET inbox_id=inbox_id WHERE organization_id=$1`, [t.org],
    ))).rejects.toMatchObject({code:'42501'});
    await expect(db.transact(t.org, tx => tx.query(
      `DELETE FROM ${table} WHERE organization_id=$1`, [t.org],
    ))).rejects.toMatchObject({code:'42501'});
  },
);

it.each([
  ['registration target UPDATE', 'GRANT UPDATE ON flow_native_registration_targets TO jrc_app'],
  ['installation target column UPDATE', 'GRANT UPDATE(inbox_id) ON flow_native_installation_targets TO jrc_app'],
  ['nondeferrable native cycle', 'ALTER TABLE flow_native_registration_challenges ALTER CONSTRAINT flow_native_challenge_registration_fk NOT DEFERRABLE'],
  ['initially deferred native cycle', 'ALTER TABLE flow_native_registration_challenges ALTER CONSTRAINT flow_native_challenge_registration_fk DEFERRABLE INITIALLY DEFERRED'],
  ['missing native cycle FK', 'ALTER TABLE flow_native_registration_challenges DROP CONSTRAINT flow_native_challenge_registration_fk'],
  ['unrestricted native pending helper', 'GRANT EXECUTE ON FUNCTION lifecycle_native_pending_count(uuid,uuid) TO jrc_app'],
] as const)('rejects readiness after %s and accepts the rolled-back baseline', async (_label, damage) => {
  const tenant = await fixture();
  const probe = () => db.transact(tenant.org, tx => probeRequiredRuntimeSchema(sql => tx.query(sql)));
  expect(await probe()).toBe(true);
  const client = await db.database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE jrc_migrator');
    await client.query(damage);
    await client.query('SET LOCAL ROLE jrc_app');
    expect(await probeRequiredRuntimeSchema(sql => client.query(sql))).toBe(false);
  } finally { await client.query('ROLLBACK'); client.release(); }
  expect(await probe()).toBe(true);
});

it('preserves an actual UNKNOWN installation operation and rejects organization deletion before dispatch', async () => {
  const t = await fixture();
  t.callback(async () => { throw new Error('Synthetic unavailable installation host'); });
  await expect(claim(t)).rejects.toMatchObject({code:'FLOW_INSTALLATION_HOST_UNAVAILABLE', statusCode:503});
  const before = await nativeRows(t.org);
  expect((await db.database.pool.query(
    'SELECT state,lease_until FROM flow_native_installation_operations WHERE organization_id=$1', [t.org],
  )).rows).toEqual([{state:'UNKNOWN',lease_until:null}]);
  const lifecycle = await nativeLifecycleFixture();
  try {
    expect(await lifecycle.platform.previewOrganization(t.org)).toMatchObject({canDelete:false, blockers:['PENDING_OR_UNCERTAIN_WORK']});
    const linked = (await db.database.pool.query(
      'SELECT i.id,i.provider_account_id FROM instances i JOIN messaging_channels c ON c.organization_id=i.organization_id AND c.instance_id=i.id WHERE c.organization_id=$1 AND c.id=$2',
      [t.org, t.channel],
    )).rows[0]!;
    expect(await lifecycle.platform.previewChannel(t.org, linked.id)).toMatchObject({canDelete:false});
    const unrelated = randomUUID();
    await db.database.pool.query(
      "INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,$3,'Unmapped synthetic QR',$4,'DISCONNECTED')",
      [unrelated, t.org, linked.provider_account_id, `synthetic-unmapped-${unrelated}`],
    );
    expect(await lifecycle.platform.previewChannel(t.org, unrelated)).toMatchObject({canDelete:true, blockers:[]});
    await expect(lifecycle.platform.requestOrganization(t.org, 'Attendance', 'Synthetic uncertain native regression', lifecycle.actor))
      .rejects.toMatchObject({code:'LIFECYCLE_PENDING_WORK', status:409});
    expect((await db.database.pool.query('SELECT id FROM lifecycle_deletions WHERE organization_id=$1', [t.org])).rowCount).toBe(0);
    expect((await db.database.pool.query('SELECT status FROM organizations WHERE id=$1', [t.org])).rows).toEqual([{status:'ACTIVE'}]);
    expect(await nativeRows(t.org)).toEqual(before);

    // Simulate a persisted deletion admitted by an older release: final purge
    // must independently preserve uncertainty even if admission was bypassed.
    const deletion = randomUUID(), lease = randomUUID();
    await db.database.pool.query(
      `INSERT INTO lifecycle_deletions(id,organization_id,kind,resource_id,actor_kind,actor_id,status,lease_token,lease_expires_at)
       VALUES($1,$2,'ORGANIZATION',$2,'PLATFORM',$3,'REMOVING_DATA',$4,clock_timestamp()+interval '10 minutes')`,
      [deletion, t.org, lifecycle.actor, lease],
    );
    await expect(lifecycle.worker.query('SELECT lifecycle_purge_organization($1,$2)', [deletion, lease]))
      .rejects.toMatchObject({code:'23514', constraint:'lifecycle_pending_work'});
    expect(await nativeRows(t.org)).toEqual(before);
    expect((await db.database.pool.query('SELECT id FROM organizations WHERE id=$1', [t.org])).rowCount).toBe(1);
  } finally { await lifecycle.dispose(); }
});
