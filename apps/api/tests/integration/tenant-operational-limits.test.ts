import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createPostgresMessagingRepository } from '../../src/modules/messaging/repository.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { connectionStringForRole } from './helpers/task7.js';

describe('transactional SaaS operational limits', () => {
  let db: IsolatedPostgresDatabase;
  let app: Pool;
  const repository = createPostgresMessagingRepository();
  beforeAll(async () => {
    const url = requireTestDatabaseAdminUrl();
    db = await createIsolatedPostgresDatabase(url);
    await withGlobalRoleLock(url, () => runMigrations(db.connectionString));
    app = new Pool({ connectionString: connectionStringForRole(db.connectionString, 'jrc_app'), max: 8 });
  });
  afterAll(async () => { await app?.end(); await db?.dispose(); });
  async function tenant() {
    const org = randomUUID(); const user = randomUUID();
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO organizations(id,name,slug) VALUES($1::uuid,$1::text,$1::text)', [org]);
      await client.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'fixture')", [user, `${user}@example.test`]);
      await client.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')", [org,user]);
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return withOrganizationTransaction(app,org,async tx => {
      const provider = (await tx.query<{id:string}>("INSERT INTO provider_accounts(organization_id,provider,name,credential_reference) VALUES($1,'META','meta','fixture') RETURNING id",[org])).rows[0]!.id;
      const channel = await repository.createChannel(tx,{id:randomUUID(),organizationId:org,providerAccountId:provider,phoneNumberId:org,wabaId:org,credentialReference:'fixture',botPublicId:null,botOriginReference:null});
      const contact = await repository.upsertContact(tx,{id:randomUUID(),organizationId:org,externalId:'fixture',displayName:null,consentStatus:'OPTED_IN',consentUpdatedAt:new Date()});
      const conversation = await repository.getOrCreateConversation(tx,{id:randomUUID(),organizationId:org,channelId:channel.id,contactId:contact.id});
      return {org,provider,channel:channel.id,conversation:conversation.id};
    });
  }
  async function enqueue(t: Awaited<ReturnType<typeof tenant>>) {
    return withOrganizationTransaction(app,t.org,tx => repository.enqueueOutgoing(tx,{
      id:randomUUID(),organizationId:t.org,channelId:t.channel,conversationId:t.conversation,
      source:'OPERATOR',content:{type:'TEMPLATE',name:'fixture',language:'pt_BR',variables:[]},
      idempotencyKey:randomUUID(),bodyHash:'fixture',policy:{requireOptIn:true},
    }));
  }
  it('serializes concurrent instance admission and isolates limits from the other tenant',async () => {
    const a = await tenant(); const b = await tenant();
    await db.pool.query('UPDATE organization_limits SET max_instances=2 WHERE organization_id=$1',[a.org]);
    const insert = (t:typeof a) => withOrganizationTransaction(app,t.org,tx=>tx.query("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key) VALUES($1,$2,$3,$3)",[t.org,t.provider,randomUUID()]));
    const results = await Promise.allSettled([insert(a),insert(a)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
    await expect(insert(b)).resolves.toBeDefined();
    expect((await withOrganizationTransaction(app,b.org,tx=>tx.query('SELECT * FROM organization_limits WHERE organization_id=$1',[a.org]))).rows).toEqual([]);
    await expect(withOrganizationTransaction(app,a.org,tx=>tx.query('UPDATE organization_limits SET max_instances=99 WHERE organization_id=$1',[a.org]))).rejects.toThrow();
  });
  it('serializes daily quota and keeps suspended pending messages available after resumption',async () => {
    const t = await tenant();
    await db.pool.query('UPDATE organization_limits SET messages_per_day=1 WHERE organization_id=$1',[t.org]);
    const outcomes = await Promise.allSettled([enqueue(t),enqueue(t)]);
    expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(outcomes.filter(r=>r.status==='rejected')).toHaveLength(1);
    await db.pool.query("UPDATE organizations SET status='SUSPENDED' WHERE id=$1",[t.org]);
    await expect(enqueue(t)).rejects.toThrow('ORGANIZATION_NOT_ACTIVE');
    expect(await withOrganizationTransaction(app,t.org,tx=>repository.claimOutgoing(tx,{organizationId:t.org,workerId:randomUUID(),now:new Date(),leaseMs:60000,limit:1}))).toEqual([]);
    expect((await db.pool.query("SELECT state FROM messaging_messages WHERE organization_id=$1",[t.org])).rows).toEqual([{state:'ACCEPTED'}]);
    await withOrganizationTransaction(app,t.org,tx=>repository.recordIncoming(tx,{id:randomUUID(),organizationId:t.org,channelId:t.channel,conversationId:t.conversation,webhookEventKey:randomUUID(),upstreamMessageId:randomUUID(),content:{type:'TEXT',text:'fixture'}}));
    await db.pool.query("UPDATE organizations SET status='ACTIVE' WHERE id=$1",[t.org]);
    expect(await withOrganizationTransaction(app,t.org,tx=>repository.claimOutgoing(tx,{organizationId:t.org,workerId:randomUUID(),now:new Date(),leaseMs:60000,limit:1}))).toHaveLength(1);
  });
  it('enforces concurrent active-user and pending-message quotas separately', async () => {
    const t = await tenant();
    await db.pool.query('UPDATE organization_limits SET max_users=2,max_pending_messages=1 WHERE organization_id=$1',[t.org]);
    const users = [randomUUID(), randomUUID()];
    for (const user of users) await db.pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'fixture')",[user,`${user}@example.test`]);
    const members = await Promise.allSettled(users.map(user => withOrganizationTransaction(app,t.org,tx=>tx.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OPERATOR')",[t.org,user]))));
    expect(members.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const pending = await Promise.allSettled([enqueue(t),enqueue(t)]);
    expect(pending.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(pending.find(r=>r.status==='rejected')).toMatchObject({reason:{constraint:'tenant_pending_limit'}});
    expect((await db.pool.query('SELECT accepted_messages FROM organization_message_usage WHERE organization_id=$1',[t.org])).rows).toEqual([{accepted_messages:1}]);
  });
  it('rechecks suspension after a claim and releases only its unsent lease', async () => {
    const t = await tenant(); await enqueue(t);
    const claims = await withOrganizationTransaction(app,t.org,tx=>repository.claimOutgoing(tx,{organizationId:t.org,workerId:randomUUID(),now:new Date(),leaseMs:60000,limit:1}));
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    await db.pool.query("UPDATE organizations SET status='SUSPENDED' WHERE id=$1",[t.org]);
    expect(await withOrganizationTransaction(app,t.org,tx=>repository.validateClaim(tx,{organizationId:t.org,messageId:claim.message.id,leaseToken:claim.leaseToken}))).toEqual({eligible:false,reason:'ORGANIZATION_NOT_ACTIVE'});
    expect((await db.pool.query('SELECT lease_token FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows).toEqual([{lease_token:null}]);
    expect((await db.pool.query('SELECT state FROM messaging_messages WHERE organization_id=$1',[t.org])).rows).toEqual([{state:'ACCEPTED'}]);
  });
  it('forces RLS and denies app-role bypass or cross-tenant status probes', async () => {
    const a = await tenant(); const b = await tenant();
    const roles = await db.pool.query("SELECT rolbypassrls FROM pg_roles WHERE rolname IN ('jrc_app','jrc_platform')");
    expect(roles.rows).toEqual([{rolbypassrls:false},{rolbypassrls:false}]);
    expect((await db.pool.query("SELECT relforcerowsecurity FROM pg_class WHERE relname IN ('organization_limits','organization_message_usage')")).rows).toEqual([{relforcerowsecurity:true},{relforcerowsecurity:true}]);
    expect((await withOrganizationTransaction(app,a.org,tx=>tx.query('SELECT tenant_is_active($1) AS active',[b.org]))).rows).toEqual([{active:false}]);
  });
  it('does not allow retry admission to bypass the pending limit or suspension', async () => {
    const t = await tenant(); const first = await enqueue(t);
    await db.pool.query("UPDATE messaging_messages SET state='FAILED' WHERE id=$1",[first.message.id]);
    await enqueue(t);
    await db.pool.query('UPDATE organization_limits SET max_pending_messages=1 WHERE organization_id=$1',[t.org]);
    const retry = () => withOrganizationTransaction(app,t.org,tx=>tx.query("UPDATE messaging_messages SET state='ACCEPTED' WHERE id=$1",[first.message.id]));
    await expect(retry()).rejects.toMatchObject({constraint:'tenant_pending_limit'});
    await db.pool.query("UPDATE organizations SET status='SUSPENDED' WHERE id=$1",[t.org]);
    await expect(retry()).rejects.toMatchObject({constraint:'tenant_organization_active'});
  });
  it('rejects a revoked Meta connection in final preflight and removes its unsent lease', async () => {
    const t=await tenant(); const connection=randomUUID();
    await db.pool.query('UPDATE messaging_channels SET credential_reference=$2 WHERE id=$1',[t.channel,`meta-db:${connection}`]);
    await db.pool.query("INSERT INTO meta_connections(id,organization_id,channel_id,waba_id,phone_number_id,encrypted_token,graph_version,status) VALUES($1,$2::uuid,$3,$2::text,$2::text,'fixture','v25.0','READY')",[connection,t.org,t.channel]);
    await enqueue(t);
    const claim=(await withOrganizationTransaction(app,t.org,tx=>repository.claimOutgoing(tx,{organizationId:t.org,workerId:randomUUID(),now:new Date(),leaseMs:60000,limit:1})))[0]!;
    await db.pool.query("UPDATE meta_connections SET status='REVOKED',encrypted_token=NULL WHERE id=$1",[connection]);
    expect(await withOrganizationTransaction(app,t.org,tx=>repository.validateClaim(tx,{organizationId:t.org,messageId:claim.message.id,leaseToken:claim.leaseToken}))).toEqual({eligible:false,reason:'META_CHANNEL_NOT_READY'});
    expect((await db.pool.query('SELECT state FROM messaging_messages WHERE id=$1',[claim.message.id])).rows).toEqual([{state:'FAILED'}]);
    expect((await db.pool.query('SELECT message_id FROM messaging_outbox WHERE message_id=$1',[claim.message.id])).rows).toEqual([]);
  });
});
