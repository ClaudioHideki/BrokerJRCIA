import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresObservabilityRepository } from '../../src/modules/observability/service.js';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';

describe('H01 Chatwoot health scope on isolated PostgreSQL', () => {
  let db: Awaited<ReturnType<typeof attendanceDatabase>>;
  const repository = createPostgresObservabilityRepository();
  beforeAll(async () => { db = await attendanceDatabase(); }, 60000);
  afterAll(async () => { await db?.dispose(); });

  async function fixture() {
    const t = await seedAttendanceTenant(db.database);
    await db.database.pool.query('UPDATE organization_limits SET max_instances=20 WHERE organization_id=$1',[t.org]);
    async function binding(status: string, health?: { connected: boolean; identityError?: string; accessError?: string }) {
      const channel = randomUUID(), integration = randomUUID();
      await db.database.pool.query(`INSERT INTO messaging_channels(id,organization_id,provider_account_id,phone_number_id,waba_id,credential_reference)
        SELECT $1::uuid,organization_id,provider_account_id,$1::text,waba_id,credential_reference FROM messaging_channels WHERE id=$2`, [channel,t.channel]);
      await db.database.pool.query(`INSERT INTO chatwoot_connections(id,organization_id,channel_id,name,status) VALUES($1,$2,$3,'H01 synthetic binding',$4)`, [integration,t.org,channel,status]);
      if (health) await db.database.pool.query(`INSERT INTO chatwoot_connection_health(organization_id,integration_id,channel_id,observed_connected,observed_at,identity_error,access_error)
        VALUES($1,$2,$3,$4,now(),$5,$6)`, [t.org,integration,channel,health.connected,health.identityError??null,health.accessError??null]);
      return integration;
    }
    async function job(integration: string, status: string) {
      await db.database.pool.query(`INSERT INTO integration_jobs(organization_id,integration_id,kind,dedupe_key,status,created_at,lease_token,lease_expires_at)
        VALUES($1,$2,'MIRROR_MESSAGE',$3,$4,now()-interval '90 days',CASE WHEN $4='RUNNING' THEN gen_random_uuid() END,CASE WHEN $4='RUNNING' THEN now()+interval '1 minute' END)`, [t.org,integration,randomUUID(),status]);
    }
    const snapshot = () => db.transact(t.org, tx => repository.snapshot(tx,t.org));
    return { ...t, binding, job, snapshot };
  }

  it('excludes disabled binding errors from active degradation and preserves their diagnostic counts', async () => {
    const t = await fixture();
    await t.binding('READY', {connected:true});
    await t.binding('DISABLED', {connected:false,accessError:'SYNTHETIC_ACCESS_DENIED'});
    expect(await t.snapshot()).toMatchObject({chatwootReady:1,chatwootActiveBindings:2,chatwootDegraded:0,chatwootDisabled:1,chatwootDisabledDegraded:1});
  });

  it.each([
    {name:'default unobserved row',identityError:null,accessError:null,observed:false,want:0},
    {name:'explicit identity error without observation',identityError:'SYNTHETIC_IDENTITY_CONFLICT',accessError:null,observed:false,want:1},
    {name:'explicit access error without observation',identityError:null,accessError:'SYNTHETIC_ACCESS_DENIED',observed:false,want:1},
    {name:'observed disconnection',identityError:null,accessError:null,observed:true,want:1},
  ])('classifies disabled binding health from evidence: $name',async input=>{
    const t=await fixture(),disabled=await t.binding('DISABLED');
    // Enrollment creates an unobserved row with observed_connected=false by default.
    await db.database.pool.query(`INSERT INTO chatwoot_connection_health(organization_id,integration_id,channel_id)
      SELECT organization_id,id,channel_id FROM chatwoot_connections WHERE id=$1`,[disabled]);
    await db.database.pool.query(`UPDATE chatwoot_connection_health SET identity_error=$2,access_error=$3,observed_at=CASE WHEN $4 THEN now() END
      WHERE integration_id=$1`,[disabled,input.identityError,input.accessError,input.observed]);
    expect(await t.snapshot()).toMatchObject({chatwootDisabled:1,chatwootDisabledDegraded:input.want,chatwootDegraded:0});
  });

  it('counts each READY binding error while excluding other statuses and other tenants', async () => {
    const t = await fixture(), other = await fixture();
    await t.binding('READY', {connected:false});
    await t.binding('READY', {connected:true,identityError:'SYNTHETIC_IDENTITY_CONFLICT'});
    await t.binding('READY', {connected:true,accessError:'SYNTHETIC_ACCESS_DENIED'});
    for (const status of ['PENDING','FAILED','UNKNOWN']) await t.binding(status, {connected:false});
    await other.binding('READY', {connected:false});
    expect(await t.snapshot()).toMatchObject({chatwootDegraded:3});
  });

  it('keeps missing observations visible instead of treating absent health rows as healthy', async () => {
    const t = await fixture();
    await t.binding('READY', {connected:true});
    await t.binding('DISABLED');
    expect(await t.snapshot()).toMatchObject({chatwootDegraded:0,chatwootUnobserved:1,chatwootDisabled:1});
  });

  it('distinguishes an approved destination from the absence of active READY bindings', async () => {
    const t = await fixture();
    await db.database.pool.query("UPDATE chatwoot_connections SET status='DISABLED' WHERE id=$1",[t.integration]);
    expect(await t.snapshot()).toMatchObject({chatwootReady:1,chatwootActiveBindings:0,chatwootUnobserved:0,chatwootDegraded:0});
  });

  it('retains old failures and UNKNOWN and separates disabled backlog without changing any jobs', async () => {
    const t = await fixture(), disabled = await t.binding('DISABLED');
    for (const status of ['PENDING','RUNNING','FAILED','UNKNOWN','SUCCEEDED']) await t.job(disabled,status);
    await t.job(t.integration,'FAILED');
    await t.job(t.integration,'UNKNOWN');
    const pending = await t.binding('PENDING');
    await t.job(pending,'FAILED');
    const before = (await db.database.pool.query('SELECT id,status FROM integration_jobs WHERE organization_id=$1 ORDER BY id',[t.org])).rows;
    expect(await t.snapshot()).toMatchObject({integrationFailures:3,integrationUnknown:2,disabledIntegrationPending:2,disabledIntegrationFailures:1,disabledIntegrationUnknown:1});
    expect((await db.database.pool.query('SELECT id,status FROM integration_jobs WHERE organization_id=$1 ORDER BY id',[t.org])).rows).toEqual(before);
  });
});
