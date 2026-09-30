import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChannelFacade } from '../../src/modules/channels/facade.js';
import { createOwnershipService } from '../../src/modules/attendance/ownership-service.js';
import { transitionChannelOwner } from '../../src/modules/attendance/transition.js';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';

describe('attendance authority release and current entitlement', () => {
  let db: Awaited<ReturnType<typeof attendanceDatabase>>;
  beforeAll(async () => { db = await attendanceDatabase(); }, 60000);
  afterAll(async () => db?.dispose());

  it('rejects facade activation when the module was disabled after its availability snapshot', async () => {
    const t = await seedAttendanceTenant(db.database, false), connection = randomUUID();
    await db.database.pool.query('insert into flow_features(organization_id,enabled) values($1,true)', [t.org]);
    await db.database.pool.query(`insert into meta_connections(id,organization_id,channel_id,waba_id,phone_number_id,graph_version,status)
      values($1::uuid,$2,$3,'synthetic',$1::text,'v23','REVOKED')`, [connection, t.org, t.channel]);
    const facade = createChannelFacade({ transact: db.transact, instances: {} as never,
      meta: { start: async () => { throw new Error('unused'); } },
      automationStatus: async () => {
        // A previously read availability result may reach the caller after the
        // commercial transaction has committed a newer module entitlement.
        await db.database.pool.query('update flow_features set enabled=false where organization_id=$1', [t.org]);
        return { canPublish: true, reasons: [] };
      },
    });
    await expect(facade.bindAutomation(t.org, connection, { automationId: t.automation, version: 1, expectedOwnerRevision: 0 }))
      .rejects.toMatchObject({ code: 'AUTOMATION_MODULE_DISABLED' });
    expect((await db.database.pool.query('select 1 from automation_bindings where organization_id=$1', [t.org])).rowCount).toBe(0);
  });

  it.each(['READY', 'DISPATCHED'] as const)('NONE revokes a %s remote owner locally and prevents late settlement', async state => {
    const t = await seedAttendanceTenant(db.database, true), binding = randomUUID(), flow = randomUUID(), event = randomUUID(), token = randomUUID();
    await db.database.pool.query('insert into flow_features(organization_id,enabled) values($1,true)', [t.org]);
    await db.database.pool.query(`insert into flows(id,organization_id,name,graph) values($1,$2,'Synthetic','{}')`, [flow, t.org]);
    await db.database.pool.query(`insert into flow_chatwoot_bindings(id,organization_id,flow_id,inbox_id,account_id,destination_revision,credential_version,feature_revision,name,channel_type,status,bot_id,operation_state,operation_token,operation_expires_at)
      values($1,$2,$3,9,7,1,1,1,'Synthetic','Channel::Api',$4,8,$5,$6,case when $6::uuid is null then null else now()+interval '2 minutes' end)`,
    [binding, t.org, flow, state === 'READY' ? 'READY' : 'PENDING', state === 'READY' ? 'IDLE' : 'DISPATCHED', state === 'READY' ? null : token]);
    await db.transact(t.org, tx => transitionChannelOwner(tx, t.org, { channelId: t.channel, botPublicId: null, botOriginReference: null,
      executor: 'BROKER', remoteBindingId: binding, expectedOwnerRevision: 0 }));
    await db.database.pool.query(`insert into flow_chatwoot_events(organization_id,id,binding_id,conversation_id,message_id,payload) values($1,$2,$3,19,29,'{}')`, [t.org, event, binding]);
    for (const [ordinal, status] of [[0, 'PENDING'], [1, 'UNKNOWN']] as const) {
      await db.database.pool.query(`insert into flow_chatwoot_outbox(organization_id,binding_id,event_id,conversation_id,ordinal,kind,content,status) values($1,$2,$3,19,$4,'TEXT','synthetic',$5)`, [t.org, binding, event, ordinal, status]);
    }
    const result = await createOwnershipService({ transact: db.transact }).claimChannelOwner(t.org, t.channel, {
      executor: 'NONE', automationId: null, version: null, expectedRevision: 1,
    });
    expect(result).toMatchObject({ executor: 'NONE', revision: 2 });
    expect((await db.database.pool.query('select status,operation_state,operation_token,operation_revision,bot_id from flow_chatwoot_bindings where id=$1', [binding])).rows[0])
      .toEqual({ status: 'DISABLED', operation_state: state === 'READY' ? 'IDLE' : 'UNKNOWN', operation_token: null, operation_revision: 2, bot_id: '8' });
    expect((await db.database.pool.query('select status from flow_chatwoot_events where id=$1', [event])).rows[0].status).toBe('PAUSED');
    expect((await db.database.pool.query('select status from flow_chatwoot_outbox where event_id=$1 order by ordinal', [event])).rows)
      .toEqual([{ status: 'CANCELED' }, { status: 'UNKNOWN' }]);
    expect((await db.database.pool.query(`update flow_chatwoot_bindings set status='READY'
      where id=$1 and operation_token=$2 and operation_revision=1 and status<>'DISABLED'`, [binding, token])).rowCount).toBe(0);
    // A fresh repeated release is a true no-op: no second operation revision.
    await createOwnershipService({ transact: db.transact }).claimChannelOwner(t.org, t.channel, {
      executor: 'NONE', automationId: null, version: null, expectedRevision: 2,
    });
    expect((await db.database.pool.query('select operation_revision from flow_chatwoot_bindings where id=$1', [binding])).rows[0].operation_revision).toBe(2);
  });
});
