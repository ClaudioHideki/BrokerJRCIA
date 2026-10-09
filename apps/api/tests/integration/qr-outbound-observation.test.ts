import { createHmac, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { createPostgresMessagingRepository } from '../../src/modules/messaging/repository.js';
import { createQrMessagingService, ensureQrChannel } from '../../src/modules/messaging/qr-service.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import * as observations from '../../src/modules/messaging/qr-outbound-observation.js';
import { createChatwootService, type ChatwootOptions } from '../../src/modules/integrations/chatwoot-service.js';
import { createChatwootWorker } from '../../src/modules/integrations/chatwoot-worker.js';
import { createMediaStore } from '../../src/modules/messaging/media-store.js';
import {readChatwootAttendanceGate} from '../../src/modules/attendance/control-service.js';

describe('P4.1 saída QR observada no PostgreSQL isolado', () => {
  let database: IsolatedPostgresDatabase, pool: Pool;
  const repository = createPostgresMessagingRepository(), signingKey = 'synthetic-p4-signing-key'.repeat(3);
  beforeAll(async () => {
    const admin = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(admin);
    await withGlobalRoleLock(admin, () => runMigrations(database.connectionString));
    pool = new Pool({ connectionString: connectionStringForRole(database.connectionString, 'jrc_app') });
  }, 60000);
  afterAll(async () => { await pool?.end(); await database?.dispose(); });

  async function harness() {
    const org = await runInAdminTransaction(database.pool, async tx => {
      const created = await createOrganization(tx, { name: 'P4 sintético', slug: `p4-${randomUUID()}` });
      const actor = (await tx.query<{ id: string }>('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id', [`${created.id}@example.test`, 'synthetic-only'])).rows[0]!.id;
      await tx.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')", [created.id, actor]);
      return {id:created.id,actor};
    });
    const actor=org.actor,organizationId=org.id;
    const transact = <T>(work: Parameters<typeof withOrganizationTransaction<T>>[2]) => withOrganizationTransaction(pool, organizationId, work);
    const upstreamKey = `p4-${randomUUID()}`;
    const { channel, instance } = await transact(async tx => {
      const provider = (await tx.query<{ id: string }>("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','QR P4') RETURNING id", [organizationId])).rows[0]!.id;
      const instance = (await tx.query<{ id: string }>("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'QR P4',$3,'CONNECTED') RETURNING id", [organizationId, provider, upstreamKey])).rows[0]!.id;
      return { channel: (await ensureQrChannel(tx, organizationId, instance)).id, instance };
    });
    let rejectWrite=false;
    const qr = createQrMessagingService({ baseUrl: 'https://engine.example.test', apiKey: 'synthetic-only', signingKey, webhookOrigin: 'https://broker.example.test',
      transact: (id, work) => withOrganizationTransaction(pool, id,async tx=>{const result=await work(tx);if(rejectWrite)throw new Error('SYNTHETIC_WRITE_FAILED');return result;}), resolveChannel: async id => id === channel ? { organizationId, instanceId: instance } : undefined });
    const auth = 'Bearer ' + createHmac('sha256', signingKey).update(`qr-webhook\0${organizationId}\0${channel}`).digest('base64url');
    const payload = (id: string, fromMe = true, message: unknown = { conversation: 'Saída sintética' }) => ({ event: 'messages.upsert', instance: upstreamKey,
      data: { key: { id, fromMe, remoteJid: '15550000001@s.whatsapp.net' }, messageTimestamp: Math.floor(Date.now() / 1000), message } });
    await qr.ingest(channel, auth, payload('synthetic-inbound', false, { conversation: 'Entrada sintética' }));
    const conversation = (await transact(tx => tx.query<{ id: string }>('SELECT id FROM messaging_conversations WHERE organization_id=$1 AND channel_id=$2', [organizationId, channel]))).rows[0]!.id;
    const outgoing = () => transact(tx => tx.query('SELECT id,direction,source,upstream_message_id,content,state FROM messaging_messages WHERE organization_id=$1 AND channel_id=$2 AND direction=\'OUTGOING\' ORDER BY sequence_number', [organizationId, channel]));
    async function sending(text = 'Saída sintética',targetConversation=conversation) {
      const result = await transact(tx => repository.enqueueOutgoing(tx, { id: randomUUID(), organizationId, channelId: channel, conversationId: targetConversation,
        source: 'OPERATOR', content: { type: 'TEXT', text }, idempotencyKey: randomUUID(), bodyHash: text, policy: { requireOptIn: false } }));
      const claim = await transact(async tx => {
        // The synthetic outbox uses PostgreSQL's default timestamp. Keep its
        // immediate claim on that clock instead of assuming host clocks agree.
        // Round up by at most 1 ms because pg converts timestamps to JS Dates.
        const now = (await tx.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) + interval '1 millisecond' AS now")).rows[0]!.now;
        return (await repository.claimOutgoing(tx, { organizationId, workerId: randomUUID(), now, leaseMs: 120000, limit: 1 }))[0];
      });
      expect(claim, 'the synthetic outbox must be available before the scenario starts').toBeDefined();
      if (!claim) throw new Error('QR_FIXTURE_CLAIM_MISSING');
      expect(await transact(tx => repository.validateClaim(tx, { organizationId, messageId: result.message.id, leaseToken: claim.leaseToken }))).toMatchObject({ eligible: true });
      return { messageId: result.message.id, leaseToken: claim.leaseToken };
    }
    return { org:organizationId,actor,channel,instance,conversation,qr,auth,payload,transact,outgoing,sending,rejectWrite:()=>{rejectWrite=true;} };
  }

  it('persiste e deduplica saída do aparelho sem outbox ou job de bot', async () => {
    const h = await harness();
    await h.qr.ingest(h.channel, h.auth, h.payload('device-id'));
    await h.qr.ingest(h.channel, h.auth, h.payload('device-id'));
    expect((await h.outgoing()).rows).toMatchObject([{ source: 'EXTERNAL_OBSERVED', direction: 'OUTGOING', upstream_message_id: 'device-id', state: 'SENT' }]);
    expect((await h.outgoing()).rows).toHaveLength(1);
    expect((await h.transact(tx => tx.query('SELECT * FROM messaging_outbox WHERE organization_id=$1', [h.org]))).rows).toHaveLength(0);
    expect((await h.transact(tx => tx.query('SELECT * FROM messaging_bot_jobs WHERE organization_id=$1', [h.org]))).rows).toHaveLength(0);
  });
  it('reaplica READ recebido antes da saída externa sem regressão nem reenvio',async()=>{
    const h=await harness();
    await h.transact(tx=>repository.recordStatusEvent(tx,{organizationId:h.org,channelId:h.channel,upstreamMessageId:'early-read-external',state:'READ'}));
    await h.qr.ingest(h.channel,h.auth,h.payload('early-read-external'));
    expect((await h.outgoing()).rows).toMatchObject([{source:'EXTERNAL_OBSERVED',state:'READ',upstream_message_id:'early-read-external'}]);
    expect((await h.transact(tx=>tx.query('SELECT * FROM messaging_outbox WHERE organization_id=$1',[h.org]))).rows).toHaveLength(0);
  });
  it('reaplica READ recebido durante reconciliação ao materializar saída externa',async()=>{
    const h=await harness(),attempt=await h.sending();
    await h.qr.ingest(h.channel,h.auth,h.payload('reconcile-read-external'));
    await h.transact(tx=>repository.recordStatusEvent(tx,{organizationId:h.org,channelId:h.channel,upstreamMessageId:'reconcile-read-external',state:'READ'}));
    // A definite provider rejection closes the broker attempt; it never proves ownership of a different observed ID.
    await h.transact(tx=>repository.completeSend(tx,{organizationId:h.org,...attempt,outcome:{state:'FAILED',canonicalErrorCode:'SYNTHETIC_REJECTED',retrySafe:false}}));
    expect((await h.outgoing()).rows).toMatchObject([{id:attempt.messageId,state:'FAILED'},{source:'EXTERNAL_OBSERVED',state:'READ',upstream_message_id:'reconcile-read-external'}]);
  });

  it('correlaciona eco antes do ACK mantendo apenas a mensagem original e controle BOT', async () => {
    const h = await harness(), attempt = await h.sending();
    await h.qr.ingest(h.channel, h.auth, h.payload('broker-id'));
    expect((await h.outgoing()).rows).toHaveLength(1);
    expect((await h.transact(tx => tx.query('SELECT mode FROM messaging_conversations WHERE organization_id=$1 AND id=$2', [h.org, h.conversation]))).rows[0]).toEqual({ mode: 'BOT' });
    expect(await h.transact(tx=>readChatwootAttendanceGate(tx,{organizationId:h.org,channelId:h.channel,conversationId:h.conversation}))).toMatchObject({allowed:false,state:'RECONCILE'});
    await h.transact(tx => repository.completeSend(tx, { organizationId: h.org, ...attempt, outcome: { state: 'SENT', upstreamMessageId: 'broker-id' } }));
    expect((await h.outgoing()).rows).toMatchObject([{ id: attempt.messageId, source: 'OPERATOR', upstream_message_id: 'broker-id', state: 'SENT' }]);
    expect((await h.transact(tx => tx.query('SELECT disposition,blocking,message_id FROM qr_outbound_observations WHERE organization_id=$1', [h.org]))).rows).toEqual([{ disposition: 'BROKER_ECHO', blocking: false, message_id: attempt.messageId }]);
    expect(await h.transact(tx=>readChatwootAttendanceGate(tx,{organizationId:h.org,channelId:h.channel,conversationId:h.conversation}))).toMatchObject({allowed:true,state:'NONE'});
  });

  it('correlaciona eco após ACK e conserva autoria de resposta originada na central', async () => {
    const h = await harness(), attempt = await h.sending();
    await h.transact(tx => repository.completeSend(tx, { organizationId: h.org, ...attempt, outcome: { state: 'SENT', upstreamMessageId: 'central-id' } }));
    await h.qr.ingest(h.channel, h.auth, h.payload('central-id'));
    expect((await h.outgoing()).rows).toHaveLength(1);
    expect((await h.outgoing()).rows[0]).toMatchObject({ id: attempt.messageId, source: 'OPERATOR' });
  });

  it('conserva eco sem ACK em reconciliação sem usar texto ou dispositivo como prova', async () => {
    const h = await harness(), attempt = await h.sending();
    await h.qr.ingest(h.channel, h.auth, { ...h.payload('uncertain-id'), source: 'android' });
    await h.transact(tx => repository.completeSend(tx, { organizationId: h.org, ...attempt, outcome: { state: 'UNKNOWN', canonicalErrorCode: 'QR_SEND_UNKNOWN' } }));
    expect((await h.outgoing()).rows).toMatchObject([{ id: attempt.messageId, state: 'UNKNOWN', upstream_message_id: null }]);
    expect((await h.transact(tx => tx.query('SELECT disposition,blocking,message_id FROM qr_outbound_observations WHERE organization_id=$1', [h.org]))).rows).toEqual([{ disposition: 'RECONCILE', blocking: true, message_id: null }]);
    expect((await h.transact(tx => tx.query('SELECT * FROM messaging_outbox WHERE organization_id=$1', [h.org]))).rows).toHaveLength(0);
  });

  it('persiste mídia observada compatível como saída externa sem enfileirar reenvio', async () => {
    const h = await harness();
    await h.qr.ingest(h.channel, h.auth, h.payload('device-media-id', true, { imageMessage: { caption: 'Mídia sintética' } }));
    expect((await h.outgoing()).rows).toMatchObject([{ source: 'EXTERNAL_OBSERVED', content: { type: 'MEDIA', kind: 'image', caption: 'Mídia sintética' } }]);
    expect((await h.transact(tx => tx.query('SELECT source,status FROM messaging_media WHERE organization_id=$1', [h.org]))).rows).toEqual([{ source: 'QR', status: 'PENDING' }]);
    expect((await h.transact(tx => tx.query('SELECT * FROM messaging_outbox WHERE organization_id=$1', [h.org]))).rows).toHaveLength(0);
  });

  it.each([
    {kind:'texto',quota:'diária',daily:1,pending:1000,constraint:'tenant_daily_limit'},
    {kind:'mídia',quota:'diária',daily:1,pending:1000,constraint:'tenant_daily_limit'},
    {kind:'texto',quota:'pendências',daily:1000,pending:1,constraint:'tenant_pending_limit'},
    {kind:'mídia',quota:'pendências',daily:1000,pending:1,constraint:'tenant_pending_limit'},
  ])('persiste fato externo de $kind com quota de $quota cheia sem nova admissão',async({kind,daily,pending,constraint})=>{
    const h=await harness();
    const otherConversation=await h.transact(async tx=>{
      const contact=await repository.upsertContact(tx,{id:randomUUID(),organizationId:h.org,externalId:'15550000002@s.whatsapp.net',displayName:null,consentStatus:'UNKNOWN',consentUpdatedAt:null});
      return (await repository.getOrCreateConversation(tx,{id:randomUUID(),organizationId:h.org,channelId:h.channel,contactId:contact.id})).id;
    });
    await database.pool.query('UPDATE organization_limits SET messages_per_day=$2,max_pending_messages=$3 WHERE organization_id=$1',[h.org,daily,pending]);
    const filler=await h.sending('Admissão sintética que ocupa a quota',otherConversation);
    await h.transact(tx=>repository.completeSend(tx,{organizationId:h.org,...filler,outcome:constraint==='tenant_daily_limit'
      ?{state:'SENT',upstreamMessageId:'synthetic-quota-filler'}:{state:'UNKNOWN',canonicalErrorCode:'QR_SEND_UNKNOWN'}}));
    await h.transact(tx=>tx.query("INSERT INTO attendance_sessions(organization_id,channel_id,conversation_id,cycle,state,owner_revision) VALUES($1,$2,$3,1,'BOT_ACTIVE',0)",[h.org,h.channel,h.conversation]));
    const usage=async()=>(await h.transact(tx=>tx.query('SELECT usage_day,accepted_messages FROM organization_message_usage WHERE organization_id=$1',[h.org]))).rows;
    const before=await usage();
    const content=kind==='mídia'?{imageMessage:{caption:'Fato externo com quota cheia'}}:{conversation:'Fato externo com quota cheia'};
    await h.qr.ingest(h.channel,h.auth,h.payload('device-quota-full',true,content));
    await h.qr.ingest(h.channel,h.auth,h.payload('device-quota-full',true,content));
    expect((await h.outgoing()).rows.filter(row=>row.source==='EXTERNAL_OBSERVED')).toMatchObject([{state:'SENT',upstream_message_id:'device-quota-full',content:{type:kind==='mídia'?'MEDIA':'TEXT'}}]);
    expect((await h.transact(tx=>tx.query('SELECT disposition,blocking FROM qr_outbound_observations WHERE organization_id=$1',[h.org]))).rows).toEqual([{disposition:'EXTERNAL_OBSERVED',blocking:false}]);
    expect((await h.transact(tx=>tx.query('SELECT state FROM attendance_sessions WHERE organization_id=$1 AND conversation_id=$2',[h.org,h.conversation]))).rows).toEqual([{state:'ADMIN_PAUSED'}]);
    expect((await h.transact(tx=>tx.query('SELECT mode FROM messaging_conversations WHERE organization_id=$1 AND id=$2',[h.org,h.conversation]))).rows).toEqual([{mode:'HUMAN'}]);
    expect((await h.transact(tx=>tx.query('SELECT * FROM messaging_outbox WHERE organization_id=$1',[h.org]))).rows).toHaveLength(0);
    expect((await h.transact(tx=>tx.query('SELECT * FROM messaging_bot_jobs WHERE organization_id=$1',[h.org]))).rows).toHaveLength(0);
    expect(await usage()).toEqual(before);
    for(const source of ['OPERATOR','AUTOMATION'] as const) {
      await expect(h.transact(tx=>repository.enqueueOutgoing(tx,{id:randomUUID(),organizationId:h.org,channelId:h.channel,conversationId:otherConversation,source,
        content:{type:'TEXT',text:'Nova admissão continua recusada'},idempotencyKey:randomUUID(),bodyHash:'synthetic',policy:{requireOptIn:false}}))).rejects.toMatchObject({constraint});
    }
    await expect(h.transact(tx=>repository.enqueueOutgoing(tx,{id:randomUUID(),organizationId:h.org,channelId:h.channel,conversationId:h.conversation,source:'AUTOMATION',
      content:{type:'TEXT',text:'Bot continua pausado'},idempotencyKey:randomUUID(),bodyHash:'synthetic',policy:{requireOptIn:false}}))).rejects.toMatchObject({code:'CONVERSATION_PAUSED'});
    expect(await usage()).toEqual(before);
  });

  it.each(['texto','mídia'])('persiste fato externo de %s durante suspensão como ingresso sem revogar humano nem admitir envio',async kind=>{
    const h=await harness();
    await h.transact(async tx=>{
      await tx.query("UPDATE messaging_conversations SET mode='HUMAN' WHERE organization_id=$1 AND id=$2",[h.org,h.conversation]);
      await tx.query("INSERT INTO attendance_sessions(organization_id,channel_id,conversation_id,cycle,state,owner_revision) VALUES($1,$2,$3,1,'HUMAN_ACTIVE',0)",[h.org,h.channel,h.conversation]);
    });
    await database.pool.query("UPDATE organizations SET status='SUSPENDED' WHERE id=$1",[h.org]);
    const content=kind==='mídia'?{imageMessage:{caption:'Fato durante suspensão'}}:{conversation:'Fato durante suspensão'};
    await h.qr.ingest(h.channel,h.auth,h.payload('device-suspended',true,content));
    await h.qr.ingest(h.channel,h.auth,h.payload('incoming-suspended',false,{conversation:'Entrada durante suspensão'}));
    expect((await h.outgoing()).rows).toMatchObject([{source:'EXTERNAL_OBSERVED',state:'SENT',upstream_message_id:'device-suspended'}]);
    expect((await h.transact(tx=>tx.query('SELECT disposition FROM qr_outbound_observations WHERE organization_id=$1',[h.org]))).rows).toEqual([{disposition:'EXTERNAL_OBSERVED'}]);
    expect((await h.transact(tx=>tx.query('SELECT state,revision FROM attendance_sessions WHERE organization_id=$1 AND conversation_id=$2',[h.org,h.conversation]))).rows).toEqual([{state:'HUMAN_ACTIVE',revision:1}]);
    expect((await h.transact(tx=>tx.query('SELECT upstream_message_id FROM messaging_messages WHERE organization_id=$1 AND direction=\'INCOMING\' ORDER BY sequence_number',[h.org]))).rows).toEqual([{upstream_message_id:'synthetic-inbound'},{upstream_message_id:'incoming-suspended'}]);
    for(const table of ['messaging_outbox','messaging_bot_jobs','automation_executions','automation_outbox','organization_message_usage'])
      expect((await h.transact(tx=>tx.query(`SELECT * FROM ${table} WHERE organization_id=$1`,[h.org]))).rows).toHaveLength(0);
    expect(await h.transact(tx=>repository.claimOutgoing(tx,{organizationId:h.org,workerId:randomUUID(),now:new Date(),leaseMs:60000,limit:1}))).toEqual([]);
    for(const source of ['OPERATOR','AUTOMATION'])
      await expect(h.transact(tx=>tx.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,content,state)
        VALUES($1,$2,$3,'OUTGOING',$4,'{"type":"TEXT","text":"New admission remains blocked"}','ACCEPTED')`,[h.org,h.channel,h.conversation,source]))).rejects.toMatchObject({constraint:'tenant_organization_active'});
  });

  it('conserva limite de armazenamento de mídia observada sem perder o fato do ingresso',async()=>{
    const h=await harness();
    await h.qr.ingest(h.channel,h.auth,h.payload('device-media-storage-limit',true,{imageMessage:{caption:'Mídia com armazenamento cheio'}}));
    const store=createMediaStore({encryptionKey:Buffer.alloc(32,11).toString('base64'),maxStorageBytes:2,transact:(org,work)=>withOrganizationTransaction(pool,org,work),
      async download(){return {bytes:new Uint8Array([1,2,3]),mimeType:'image/png',kind:'image' as const,fileName:'synthetic.png'};}});
    await store.runOnce(h.org);
    expect((await h.transact(tx=>tx.query('SELECT status,last_error,byte_size FROM messaging_media WHERE organization_id=$1',[h.org]))).rows).toEqual([{status:'FAILED',last_error:'MEDIA_STORAGE_LIMIT',byte_size:null}]);
    expect((await h.outgoing()).rows).toMatchObject([{source:'EXTERNAL_OBSERVED',state:'SENT'}]);
    expect((await h.transact(tx=>tx.query('SELECT disposition FROM qr_outbound_observations WHERE organization_id=$1',[h.org]))).rows).toEqual([{disposition:'EXTERNAL_OBSERVED'}]);
    expect((await h.transact(tx=>tx.query('SELECT * FROM messaging_outbox WHERE organization_id=$1',[h.org]))).rows).toHaveLength(0);
  });

  it('preserva fence lifecycle e constraints ao excluir fatos externos da admissão',async()=>{
    const h=await harness();
    await h.transact(tx=>tx.query('UPDATE messaging_channels SET deleting_at=now() WHERE organization_id=$1 AND id=$2',[h.org,h.channel]));
    for(const [id,content] of [['deleted-text',{conversation:'Fato bloqueado por exclusão'}],['deleted-media',{imageMessage:{caption:'Fato bloqueado por exclusão'}}]] as const)
      await expect(h.qr.ingest(h.channel,h.auth,h.payload(id,true,content))).rejects.toMatchObject({constraint:'channel_deletion_in_progress'});
    expect((await h.outgoing()).rows).toHaveLength(0);
    expect((await h.transact(tx=>tx.query('SELECT * FROM qr_outbound_observations WHERE organization_id=$1',[h.org]))).rows).toHaveLength(0);
    expect((await h.transact(tx=>tx.query('SELECT * FROM messaging_media WHERE organization_id=$1',[h.org]))).rows).toHaveLength(0);
    const active=await harness();
    await expect(active.transact(tx=>tx.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,content,state)
      VALUES($1,$2,$3,'INCOMING','EXTERNAL_OBSERVED','{"type":"TEXT","text":"Invalid source"}','DELIVERED')`,[active.org,active.channel,active.conversation]))).rejects.toMatchObject({constraint:'messaging_messages_direction_source'});
    const functionMetadata=(await database.pool.query(`SELECT owner.rolname,func.prosecdef,func.proconfig,has_function_privilege('public','public.enforce_tenant_operational_limits()','EXECUTE') AS public_execute
      FROM pg_proc func JOIN pg_roles owner ON owner.oid=func.proowner WHERE func.oid='public.enforce_tenant_operational_limits()'::regprocedure`)).rows[0];
    expect(functionMetadata).toEqual({rolname:'jrc_migrator',prosecdef:true,proconfig:['search_path=pg_catalog, public'],public_execute:false});
  });

  it.each(['DISPATCHED','UNKNOWN','ABANDONED'] as const)('bloqueia eco novo após resolução anterior à fence com tentativa %s sem INSERT canônico',async state=>{
    const h=await harness(),attempt=await h.sending();
    if(state!=='DISPATCHED')
      await h.transact(tx=>repository.completeSend(tx,{organizationId:h.org,...attempt,outcome:{state:'UNKNOWN',canonicalErrorCode:'QR_SEND_UNKNOWN'}}));
    if(state==='ABANDONED') {
      const uncertain=(await h.transact(tx=>observations.listQrDispatchAttempts(tx,h.org,h.conversation))).data[0]!;
      await h.transact(tx=>observations.abandonQrDispatchAttempt(tx,{organizationId:h.org,id:uncertain.id,expectedRevision:uncertain.revision,actorId:h.actor,reason:'Abandono explícito anterior à exclusão'}));
    }
    await h.qr.ingest(h.channel,h.auth,h.payload('existing-before-fence'));
    const snapshot=(await h.transact(tx=>tx.query('SELECT * FROM qr_outbound_observations WHERE organization_id=$1',[h.org]))).rows;
    let resolved!:()=>void,release!:()=>void;
    const bindingResolved=new Promise<void>(resolve=>{resolved=resolve;}),fenceCommitted=new Promise<void>(resolve=>{release=resolve;});
    const racingQr=createQrMessagingService({baseUrl:'https://engine.example.test',apiKey:'synthetic-only',signingKey,webhookOrigin:'https://broker.example.test',
      transact:(org,work)=>withOrganizationTransaction(pool,org,work),async resolveChannel(id) {
        const row=(await pool.query<{organization_id:string;instance_id:string}>('SELECT * FROM resolve_qr_channel($1)',[id])).rows[0];
        resolved();await fenceCommitted;
        return row?{organizationId:row.organization_id,instanceId:row.instance_id}:undefined;
      }});
    const ingress=racingQr.ingest(h.channel,h.auth,h.payload('new-after-fence'));
    await bindingResolved;
    await database.pool.query('UPDATE messaging_channels SET deleting_at=now() WHERE organization_id=$1 AND id=$2',[h.org,h.channel]);
    const rejected=expect(ingress).rejects.toMatchObject({constraint:'channel_deletion_in_progress'});
    release();await rejected;
    expect((await h.transact(tx=>tx.query('SELECT * FROM qr_outbound_observations WHERE organization_id=$1',[h.org]))).rows).toEqual(snapshot);
    expect((await h.outgoing()).rows).toHaveLength(1);
    expect((await h.outgoing()).rows[0]!.source).toBe('OPERATOR');
    expect((await h.transact(tx=>tx.query('SELECT mode FROM messaging_conversations WHERE organization_id=$1 AND id=$2',[h.org,h.conversation]))).rows).toEqual([{mode:'BOT'}]);
  });

  it('fecha fence de organização para nova observação incerta sem bloquear drenagem do ACK existente',async()=>{
    const h=await harness(),attempt=await h.sending();
    await h.qr.ingest(h.channel,h.auth,h.payload('existing-before-organization-fence'));
    await database.pool.query(`INSERT INTO lifecycle_deletions(organization_id,kind,resource_id,actor_kind,actor_id)
      VALUES($1,'ORGANIZATION',$1,'TENANT',$2)`,[h.org,h.actor]);
    await expect(h.qr.ingest(h.channel,h.auth,h.payload('new-after-organization-fence'))).rejects.toMatchObject({constraint:'organization_deletion_in_progress'});
    await h.transact(tx=>repository.completeSend(tx,{organizationId:h.org,...attempt,outcome:{state:'SENT',upstreamMessageId:'existing-before-organization-fence'}}));
    expect((await h.outgoing()).rows).toMatchObject([{id:attempt.messageId,source:'OPERATOR',state:'SENT',upstream_message_id:'existing-before-organization-fence'}]);
    expect((await h.transact(tx=>tx.query('SELECT disposition,blocking FROM qr_outbound_observations WHERE organization_id=$1',[h.org]))).rows).toEqual([{disposition:'BROKER_ECHO',blocking:false}]);
    expect((await h.transact(tx=>tx.query('SELECT state FROM qr_dispatch_attempts WHERE organization_id=$1',[h.org]))).rows).toEqual([{state:'CONFIRMED'}]);
    expect((await h.transact(tx=>tx.query('SELECT * FROM messaging_outbox WHERE organization_id=$1',[h.org]))).rows).toHaveLength(0);
  });

  it('preserva ACK e abandono do ledger existente após deleting_at sem criar novo ingresso',async()=>{
    const h=await harness(),attempt=await h.sending();
    await h.qr.ingest(h.channel,h.auth,h.payload('existing-before-channel-fence'));
    await database.pool.query('UPDATE messaging_channels SET deleting_at=now() WHERE organization_id=$1 AND id=$2',[h.org,h.channel]);
    await h.transact(tx=>repository.completeSend(tx,{organizationId:h.org,...attempt,outcome:{state:'SENT',upstreamMessageId:'existing-before-channel-fence'}}));
    expect((await h.transact(tx=>tx.query('SELECT disposition,blocking FROM qr_outbound_observations WHERE organization_id=$1',[h.org]))).rows).toEqual([{disposition:'BROKER_ECHO',blocking:false}]);
    expect((await h.transact(tx=>tx.query('SELECT * FROM messaging_outbox WHERE organization_id=$1',[h.org]))).rows).toHaveLength(0);
    const uncertain=await harness(),unknownAttempt=await uncertain.sending();
    await uncertain.qr.ingest(uncertain.channel,uncertain.auth,uncertain.payload('unknown-before-channel-fence'));
    await uncertain.transact(tx=>repository.completeSend(tx,{organizationId:uncertain.org,...unknownAttempt,outcome:{state:'UNKNOWN',canonicalErrorCode:'QR_SEND_UNKNOWN'}}));
    const o=(await uncertain.transact(tx=>tx.query('SELECT id,revision FROM qr_outbound_observations WHERE organization_id=$1',[uncertain.org]))).rows[0]!;
    const attemptIds=(await uncertain.transact(tx=>tx.query('SELECT id FROM qr_dispatch_attempts WHERE organization_id=$1',[uncertain.org]))).rows.map(row=>row.id);
    await database.pool.query('UPDATE messaging_channels SET deleting_at=now() WHERE organization_id=$1 AND id=$2',[uncertain.org,uncertain.channel]);
    await uncertain.transact(tx=>observations.abandonQrOutboundObservation(tx,{organizationId:uncertain.org,id:o.id,expectedRevision:o.revision,attemptIds,actorId:uncertain.actor,reason:'Drenagem administrativa sem novo envio'}));
    expect((await uncertain.transact(tx=>tx.query('SELECT disposition,blocking FROM qr_outbound_observations WHERE organization_id=$1',[uncertain.org]))).rows).toEqual([{disposition:'ABANDONED',blocking:false}]);
    expect((await uncertain.outgoing()).rows).toMatchObject([{id:unknownAttempt.messageId,state:'UNKNOWN',upstream_message_id:null}]);
    expect((await uncertain.transact(tx=>tx.query('SELECT * FROM messaging_outbox WHERE organization_id=$1',[uncertain.org]))).rows).toHaveLength(0);
  });

  async function restoredDeletionFence(h:Awaited<ReturnType<typeof harness>>,fence:'CHANNEL'|'ORGANIZATION') {
    let actor=h.actor;
    if(fence==='ORGANIZATION') {
      actor=randomUUID();
      await database.pool.query(`INSERT INTO platform_users(id,email,password_hash,role,mfa_seed) VALUES($1,$2,'synthetic-only','SUPER_ADMIN','synthetic-only')`,[actor,`${actor}@example.test`]);
    }
    const platformPool=new Pool({connectionString:connectionStringForRole(database.connectionString,'jrc_platform')});
    try {
      // The current API preflight protects a live dispatch. Restore its resulting
      // fence fields synthetically to exercise a delayed callback defensively.
      await expect(fence==='CHANNEL'
        ?platformPool.query('SELECT lifecycle_request_channel($1,$2,$3,$4,$5,$6)',[h.org,h.instance,'QR P4','Exclusão sintética durante I/O','TENANT',actor])
        :platformPool.query('SELECT lifecycle_request_organization($1,$2,$3,$4)',[h.org,'P4 sintético','Exclusão sintética durante I/O',actor])).rejects.toMatchObject({constraint:'lifecycle_pending_work'});
    }finally{await platformPool.end();}
    let deletion:string;
    if(fence==='CHANNEL') {
      deletion=(await database.pool.query<{id:string}>(`INSERT INTO lifecycle_deletions(organization_id,kind,resource_id,messaging_channel_id,provider,actor_kind,actor_id)
        VALUES($1,'CHANNEL',$2,$3,'QR','TENANT',$4) RETURNING id`,[h.org,h.instance,h.channel,actor])).rows[0]!.id;
      await database.pool.query('UPDATE messaging_channels SET deleting_at=now() WHERE organization_id=$1 AND id=$2',[h.org,h.channel]);
      await database.pool.query('UPDATE instances SET archived_at=now() WHERE organization_id=$1 AND id=$2',[h.org,h.instance]);
    }else {
      deletion=(await database.pool.query<{id:string}>(`INSERT INTO lifecycle_deletions(organization_id,kind,resource_id,actor_kind,actor_id)
        VALUES($1,'ORGANIZATION',$1,'PLATFORM',$2) RETURNING id`,[h.org,actor])).rows[0]!.id;
      await database.pool.query("UPDATE organizations SET status='DISABLED' WHERE id=$1",[h.org]);
      expect((await database.pool.query('SELECT status FROM organizations WHERE id=$1',[h.org])).rows).toEqual([{status:'DISABLED'}]);
    }
    await database.pool.query(`INSERT INTO lifecycle_cleanup_items(deletion_id,instance_id,upstream_key)
      SELECT $1,id,upstream_instance_key FROM instances WHERE organization_id=$2`,[deletion,h.org]);
    return deletion;
  }
  async function readyPurge(deletion:string) {
    const lease=randomUUID();
    await database.pool.query("UPDATE lifecycle_cleanup_items SET status='DONE' WHERE deletion_id=$1",[deletion]);
    await database.pool.query("UPDATE lifecycle_deletions SET status='REMOVING_DATA',lease_token=$2,lease_expires_at=now()+interval '1 minute' WHERE id=$1",[deletion,lease]);
    return lease;
  }

  it.each([
    {fence:'CHANNEL',ack:'FAILED'},{fence:'ORGANIZATION',ack:'FAILED'},
    {fence:'CHANNEL',ack:'SENT'},{fence:'ORGANIZATION',ack:'SENT'},
  ] as const)('preserva ACK final $ack depois da fence $fence com eco anterior distinto e drena sem nova materialização',async({fence,ack})=>{
    const h=await harness(),attempt=await h.sending();
    await h.qr.ingest(h.channel,h.auth,h.payload('different-old-observed-id'));
    const deletion=await restoredDeletionFence(h,fence);
    await h.transact(tx=>repository.completeSend(tx,{organizationId:h.org,...attempt,outcome:ack==='FAILED'
      ?{state:'FAILED',canonicalErrorCode:'SYNTHETIC_DEFINITE_REJECTED',retrySafe:false}:{state:'SENT',upstreamMessageId:'different-final-ack-id'}}));
    const providerId=ack==='FAILED'?null:'different-final-ack-id';
    expect((await h.outgoing()).rows).toMatchObject([{id:attempt.messageId,source:'OPERATOR',state:ack,upstream_message_id:providerId}]);
    expect((await h.transact(tx=>tx.query('SELECT state,provider_message_id FROM qr_dispatch_attempts WHERE organization_id=$1',[h.org]))).rows).toEqual([{state:ack==='FAILED'?'REJECTED':'CONFIRMED',provider_message_id:providerId}]);
    expect((await h.transact(tx=>tx.query('SELECT * FROM messaging_outbox WHERE organization_id=$1',[h.org]))).rows).toHaveLength(0);
    expect((await h.transact(tx=>tx.query('SELECT * FROM messaging_bot_jobs WHERE organization_id=$1',[h.org]))).rows).toHaveLength(0);
    expect((await h.transact(tx=>tx.query('SELECT mode FROM messaging_conversations WHERE organization_id=$1 AND id=$2',[h.org,h.conversation]))).rows).toEqual([{mode:'BOT'}]);
    const pending=(await h.transact(tx=>observations.listQrOutboundObservations(tx,h.org,h.conversation))).data;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({disposition:'RECONCILE',blocking:false,reason:'QR_LIFECYCLE_RECONCILE',attempts:[]});
    expect((await h.transact(tx=>tx.query('SELECT message_id,abandoned_by FROM qr_outbound_observations WHERE organization_id=$1',[h.org]))).rows).toEqual([{message_id:null,abandoned_by:null}]);
    const worker=new Pool({connectionString:connectionStringForRole(database.connectionString,'jrc_lifecycle')});
    try {
      expect((await worker.query('SELECT lifecycle_pending_count($1,$2,NULL)::int AS count',[h.org,fence==='CHANNEL'?h.channel:null])).rows).toEqual([{count:0}]);
      const lease=await readyPurge(deletion);
      await worker.query(fence==='CHANNEL'?'SELECT lifecycle_purge_channel($1,$2)':'SELECT lifecycle_purge_organization($1,$2)',[deletion,lease]);
    }finally{await worker.end();}
    expect((await database.pool.query('SELECT status FROM lifecycle_deletions WHERE id=$1',[deletion])).rows).toEqual([{status:'COMPLETED'}]);
    for(const table of ['qr_outbound_observations','qr_dispatch_attempts','messaging_messages','messaging_outbox'])
      expect((await database.pool.query(`SELECT organization_id FROM ${table} WHERE organization_id=$1`,[h.org])).rows).toHaveLength(0);
  });

  it.each(['CHANNEL','ORGANIZATION'] as const)('conserva resultado UNKNOWN bloqueante após fence %s sem usar exclusão como certeza',async fence=>{
    const h=await harness(),attempt=await h.sending();
    await h.qr.ingest(h.channel,h.auth,h.payload('old-unknown-before-fence'));
    const deletion=await restoredDeletionFence(h,fence);
    await h.transact(tx=>repository.completeSend(tx,{organizationId:h.org,...attempt,outcome:{state:'UNKNOWN',canonicalErrorCode:'QR_SEND_UNKNOWN'}}));
    expect((await h.outgoing()).rows).toMatchObject([{id:attempt.messageId,source:'OPERATOR',state:'UNKNOWN',upstream_message_id:null}]);
    expect((await h.transact(tx=>tx.query('SELECT state,provider_message_id FROM qr_dispatch_attempts WHERE organization_id=$1',[h.org]))).rows).toEqual([{state:'UNKNOWN',provider_message_id:null}]);
    expect((await h.transact(tx=>observations.listQrOutboundObservations(tx,h.org,h.conversation))).data).toMatchObject([{disposition:'RECONCILE',blocking:true,reason:'QR_ACK_PENDING',attempts:[{state:'UNKNOWN'}]}]);
    expect((await h.transact(tx=>tx.query('SELECT * FROM messaging_outbox WHERE organization_id=$1',[h.org]))).rows).toHaveLength(0);
    const worker=new Pool({connectionString:connectionStringForRole(database.connectionString,'jrc_lifecycle')});
    try {
      expect(Number((await worker.query('SELECT lifecycle_pending_count($1,$2,NULL)::int AS count',[h.org,fence==='CHANNEL'?h.channel:null])).rows[0]!.count)).toBeGreaterThan(0);
      const lease=await readyPurge(deletion);
      await expect(worker.query(fence==='CHANNEL'?'SELECT lifecycle_purge_channel($1,$2)':'SELECT lifecycle_purge_organization($1,$2)',[deletion,lease])).rejects.toMatchObject({constraint:'lifecycle_pending_work'});
    }finally{await worker.end();}
  });

  it('mantém provider IDs iguais separados por organização e conexão', async () => {
    const a = await harness(), b = await harness();
    await a.qr.ingest(a.channel, a.auth, a.payload('same-provider-id'));
    await b.qr.ingest(b.channel, b.auth, b.payload('same-provider-id'));
    expect((await a.outgoing()).rows).toHaveLength(1);
    expect((await b.outgoing()).rows).toHaveLength(1);
    expect((await a.outgoing()).rows[0]!.id).not.toBe((await b.outgoing()).rows[0]!.id);
  });
  it('rejeita ingresso quando a persistência falha antes do ACK e desfaz efeitos do bot',async()=>{
    const h=await harness();h.rejectWrite();
    await expect(h.qr.ingest(h.channel,h.auth,h.payload('rollback-observation'))).rejects.toThrow('SYNTHETIC_WRITE_FAILED');
    expect((await h.outgoing()).rows).toHaveLength(0);
    expect((await h.transact(tx=>tx.query('SELECT id FROM qr_outbound_observations WHERE organization_id=$1',[h.org]))).rows).toHaveLength(0);
    expect((await h.transact(tx=>tx.query('SELECT mode FROM messaging_conversations WHERE organization_id=$1 AND id=$2',[h.org,h.conversation]))).rows).toEqual([{mode:'BOT'}]);
  });

  it('recupera callback não persistido como UNKNOWN sem reenviar nem classificar por conteúdo', async () => {
    const h=await harness(),attempt=await h.sending();
    await h.qr.ingest(h.channel,h.auth,h.payload('before-crash'));
    await h.transact(tx=>tx.query(`UPDATE qr_dispatch_attempts SET lease_expires_at=now()-interval '1 second' WHERE organization_id=$1`,[h.org]));
    await h.transact(tx=>observations.recoverQrOutboundObservations(tx,h.org));
    expect((await h.outgoing()).rows).toMatchObject([{id:attempt.messageId,state:'UNKNOWN',upstream_message_id:null}]);
    expect((await h.transact(tx=>tx.query('SELECT state FROM qr_dispatch_attempts WHERE organization_id=$1',[h.org]))).rows).toEqual([{state:'UNKNOWN'}]);
    expect((await h.transact(tx=>tx.query('SELECT blocking,disposition FROM qr_outbound_observations WHERE organization_id=$1',[h.org]))).rows).toEqual([{blocking:true,disposition:'RECONCILE'}]);
    expect((await h.transact(tx=>tx.query('SELECT * FROM messaging_outbox WHERE organization_id=$1',[h.org]))).rows).toHaveLength(0);
  });
  it('recuperação e expiração concorrem sem inverter locks de mensagem e outbox',async()=>{
    const h=await harness(),attempt=await h.sending();
    await h.transact(async tx=>{
      await tx.query(`UPDATE qr_dispatch_attempts SET lease_expires_at=now()-interval '1 second' WHERE organization_id=$1`,[h.org]);
      await tx.query(`UPDATE messaging_outbox SET lease_expires_at=now()-interval '1 second' WHERE organization_id=$1`,[h.org]);
    });
    let announceHeld!:()=>void,continueRecovery!:()=>void;
    const held=new Promise<void>(resolve=>{announceHeld=resolve;}),proceed=new Promise<void>(resolve=>{continueRecovery=resolve;});
    const recovering=h.transact(async tx=>{
      const wrapped=new Proxy(tx,{get(target,key){if(key!=='query')return Reflect.get(target,key);return async(sql:string,args?:unknown[])=>{
        const result=await target.query(sql,args);
        if(sql.includes('WITH expired AS (UPDATE qr_dispatch_attempts')){announceHeld();await proceed;}
        return result;
      };}});
      await observations.recoverQrOutboundObservations(wrapped,h.org);
    });
    await held;
    const claiming=h.transact(async tx=>{
      await tx.query('SET LOCAL lock_timeout=\'5s\'');
      await tx.query('SELECT message_id FROM messaging_outbox WHERE organization_id=$1 AND message_id=$2 FOR UPDATE',[h.org,attempt.messageId]);
      continueRecovery();
      return repository.claimOutgoing(tx,{organizationId:h.org,workerId:randomUUID(),now:new Date(),leaseMs:120000,limit:1});
    });
    const results=await Promise.allSettled([recovering,claiming]);
    expect(results.map(result=>result.status)).toEqual(['fulfilled','fulfilled']);
    expect((await h.outgoing()).rows).toMatchObject([{id:attempt.messageId,state:'UNKNOWN'}]);
    expect((await h.transact(tx=>tx.query('SELECT message_id FROM messaging_outbox WHERE organization_id=$1',[h.org]))).rows).toHaveLength(0);
  },15000);
  it('recupera tentativa UNKNOWN sem eco por abandono explícito sem fabricar observação ou envio',async()=>{
    const h=await harness(),attempt=await h.sending();
    await h.transact(tx=>tx.query(`UPDATE qr_dispatch_attempts SET lease_expires_at=now()-interval '1 second' WHERE organization_id=$1`,[h.org]));
    await h.transact(tx=>observations.recoverQrOutboundObservations(tx,h.org));
    const ops=observations as unknown as {listQrDispatchAttempts:(tx:Parameters<typeof observations.recoverQrOutboundObservations>[0],org:string,conversation:string)=>Promise<{data:Array<{id:string;revision:number;state:string}>}>;abandonQrDispatchAttempt:(tx:Parameters<typeof observations.recoverQrOutboundObservations>[0],input:unknown)=>Promise<unknown>};
    const listed=await h.transact(tx=>ops.listQrDispatchAttempts(tx,h.org,h.conversation));
    expect(listed.data).toMatchObject([{state:'UNKNOWN',revision:2}]);
    expect((await h.transact(tx=>tx.query('SELECT id FROM qr_outbound_observations WHERE organization_id=$1',[h.org]))).rows).toHaveLength(0);
    const uncertain=listed.data[0]!;
    await expect(h.transact(tx=>ops.abandonQrDispatchAttempt(tx,{organizationId:h.org,id:uncertain.id,expectedRevision:uncertain.revision+1,actorId:h.actor,reason:'Sem eco, abandono sem reenviar'}))).rejects.toMatchObject({code:'QR_ATTEMPT_CHANGED'});
    await h.transact(tx=>ops.abandonQrDispatchAttempt(tx,{organizationId:h.org,id:uncertain.id,expectedRevision:uncertain.revision,actorId:h.actor,reason:'Sem eco, abandono sem reenviar'}));
    expect((await h.outgoing()).rows).toMatchObject([{id:attempt.messageId,state:'UNKNOWN',upstream_message_id:null}]);
    expect((await h.transact(tx=>tx.query('SELECT id FROM qr_outbound_observations WHERE organization_id=$1',[h.org]))).rows).toHaveLength(0);
    expect((await h.transact(tx=>tx.query('SELECT * FROM messaging_outbox WHERE organization_id=$1',[h.org]))).rows).toHaveLength(0);
    expect((await h.transact(tx=>tx.query("SELECT actor_id FROM integration_audit WHERE organization_id=$1 AND action='QR_DISPATCH_ATTEMPT_ABANDONED'",[h.org]))).rows).toEqual([{actor_id:h.actor}]);
    await h.qr.ingest(h.channel,h.auth,h.payload('late-no-echo-attempt'));
    expect((await h.outgoing()).rows).toHaveLength(1);
    expect((await h.transact(tx=>tx.query('SELECT blocking,disposition FROM qr_outbound_observations WHERE organization_id=$1',[h.org]))).rows).toEqual([{blocking:false,disposition:'RECONCILE'}]);
    expect((await h.sending('Nova ação após abandono sem eco')).messageId).not.toBe(attempt.messageId);
  });

  it('abandona pendência explicitamente mantendo UNKNOWN e eco tardio sem autoria inventada', async () => {
    const h=await harness(),attempt=await h.sending();
    await h.qr.ingest(h.channel,h.auth,h.payload('uncertain-to-abandon'));
    await h.transact(tx=>repository.completeSend(tx,{organizationId:h.org,...attempt,outcome:{state:'UNKNOWN',canonicalErrorCode:'QR_SEND_UNKNOWN'}}));
    const o=(await h.transact(tx=>tx.query('SELECT id,revision FROM qr_outbound_observations WHERE organization_id=$1',[h.org]))).rows[0]!;
    const attempts=(await h.transact(tx=>tx.query('SELECT id FROM qr_dispatch_attempts WHERE organization_id=$1',[h.org]))).rows.map(row=>row.id);
    const abandon=(observations as unknown as {abandonQrOutboundObservation: (tx:Parameters<typeof observations.recoverQrOutboundObservations>[0],input:unknown)=>Promise<unknown>}).abandonQrOutboundObservation;
    await h.transact(tx=>abandon(tx,{organizationId:h.org,id:o.id,expectedRevision:o.revision,attemptIds:attempts,actorId:h.actor,reason:'Operação sintética abandonada sem reenvio'}));
    expect((await h.outgoing()).rows).toMatchObject([{id:attempt.messageId,state:'UNKNOWN',upstream_message_id:null}]);
    expect((await h.transact(tx=>tx.query('SELECT disposition,blocking FROM qr_outbound_observations WHERE organization_id=$1 AND id=$2',[h.org,o.id]))).rows).toEqual([{disposition:'ABANDONED',blocking:false}]);
    await h.qr.ingest(h.channel,h.auth,h.payload('late-unproven-echo'));
    expect((await h.outgoing()).rows).toHaveLength(1);
    expect((await h.transact(tx=>tx.query('SELECT disposition,blocking,reason FROM qr_outbound_observations WHERE organization_id=$1 AND provider_message_id=$2',[h.org,'late-unproven-echo']))).rows).toEqual([{disposition:'RECONCILE',blocking:false,reason:'QR_ABANDONED_ATTEMPT_UNRESOLVED'}]);
    // A new operator attempt is allowed, without replaying the old unknown message.
    const next=await h.sending('Nova ação explícita');
    expect(next.messageId).not.toBe(attempt.messageId);
  });
  it('rejeita revisão antiga, conjunto de tentativas diferente e despacho ainda ativo',async()=>{
    const h=await harness(),attempt=await h.sending();await h.qr.ingest(h.channel,h.auth,h.payload('guarded-abandon'));
    const o=(await h.transact(tx=>tx.query('SELECT id,revision FROM qr_outbound_observations WHERE organization_id=$1',[h.org]))).rows[0]!;
    const ids=(await h.transact(tx=>tx.query('SELECT id FROM qr_dispatch_attempts WHERE organization_id=$1',[h.org]))).rows.map(row=>row.id);
    const input={organizationId:h.org,id:o.id,expectedRevision:o.revision,attemptIds:ids,actorId:h.actor,reason:'Abandono sintético sem reenvio'};
    await expect(h.transact(tx=>observations.abandonQrOutboundObservation(tx,input))).rejects.toMatchObject({code:'QR_DISPATCH_STILL_ACTIVE'});
    await h.transact(tx=>repository.completeSend(tx,{organizationId:h.org,...attempt,outcome:{state:'UNKNOWN',canonicalErrorCode:'QR_SEND_UNKNOWN'}}));
    await expect(h.transact(tx=>observations.abandonQrOutboundObservation(tx,{...input,expectedRevision:o.revision+1}))).rejects.toMatchObject({code:'QR_OBSERVATION_CHANGED'});
    await expect(h.transact(tx=>observations.abandonQrOutboundObservation(tx,{...input,attemptIds:[]}))).rejects.toMatchObject({code:'QR_ATTEMPTS_CHANGED'});
    await runInAdminTransaction(database.pool,async tx=>{
      const replacement=(await tx.query("INSERT INTO users(email,password_hash) VALUES($1,'synthetic') RETURNING id",[`${randomUUID()}@example.test`])).rows[0]!.id;
      await tx.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')",[h.org,replacement]);
      await tx.query("UPDATE memberships SET role='OPERATOR' WHERE organization_id=$1 AND user_id=$2",[h.org,h.actor]);
    });
    await expect(h.transact(tx=>observations.abandonQrOutboundObservation(tx,input))).rejects.toMatchObject({code:'FORBIDDEN'});
    expect((await h.outgoing()).rows).toHaveLength(1);
    expect((await h.transact(tx=>tx.query('SELECT blocking FROM qr_outbound_observations WHERE organization_id=$1',[h.org]))).rows).toEqual([{blocking:true}]);
  });
  it('mantém pendência visível após cem tombstones e retorna abandono fora da janela de listagem',async()=>{
    const h=await harness(),attempt=await h.sending();
    await h.transact(tx=>tx.query(`INSERT INTO qr_outbound_observations(organization_id,channel_id,conversation_id,provider_message_id,content,occurred_at,disposition,blocking,reason,abandoned_by,abandonment_reason,created_at)
      SELECT $1,$2,$3,'tombstone-'||n,'{"type":"TEXT","text":"Sintético"}'::jsonb,now(),'ABANDONED',false,'QR_OBSERVATION_ABANDONED',$4,'Sintético',now()-interval '1 day'
      FROM generate_series(1,100) n`,[h.org,h.channel,h.conversation,h.actor]));
    await h.qr.ingest(h.channel,h.auth,h.payload('new-visible-pending'));
    await h.transact(tx=>repository.completeSend(tx,{organizationId:h.org,...attempt,outcome:{state:'UNKNOWN',canonicalErrorCode:'QR_SEND_UNKNOWN'}}));
    const active=(await h.transact(tx=>tx.query('SELECT id,revision FROM qr_outbound_observations WHERE organization_id=$1 AND provider_message_id=$2',[h.org,'new-visible-pending']))).rows[0]!;
    expect((await h.transact(tx=>observations.listQrOutboundObservations(tx,h.org,h.conversation))).data[0]!.id).toBe(active.id);
    await h.transact(tx=>tx.query(`INSERT INTO qr_outbound_observations(organization_id,channel_id,conversation_id,provider_message_id,content,occurred_at,created_at)
      SELECT $1,$2,$3,'future-pending-'||n,'{"type":"TEXT","text":"Sintético"}'::jsonb,now(),now()+interval '1 minute' FROM generate_series(1,101) n`,[h.org,h.channel,h.conversation]));
    expect((await h.transact(tx=>observations.listQrOutboundObservations(tx,h.org,h.conversation))).data.some(o=>o.id===active.id)).toBe(false);
    const attempts=(await h.transact(tx=>tx.query('SELECT id FROM qr_dispatch_attempts WHERE organization_id=$1',[h.org]))).rows.map(row=>row.id);
    expect(await h.transact(tx=>observations.abandonQrOutboundObservation(tx,{organizationId:h.org,id:active.id,expectedRevision:active.revision,attemptIds:attempts,actorId:h.actor,reason:'Abandono sintético fora da janela'}))).toMatchObject({id:active.id,disposition:'ABANDONED',blocking:false});
  });

  async function mirror(h:Awaited<ReturnType<typeof harness>>) {
    const sent:Array<{text:string;bytes?:Uint8Array;attributes:unknown}>=[];
    let nextMessageId=60;
    const options:ChatwootOptions={baseUrl:`https://${h.org}.example.test`,publicOrigin:'https://broker.example.test',encryptionKey:Buffer.alloc(32,11).toString('base64'),
      controlEnabled:false,embedEnabled:false,transact:(org,work)=>withOrganizationTransaction(pool,org,work),resolveIntegration:async()=>h.org,
      async fetch(input,init) {
        const path=new URL(String(input)).pathname,method=init?.method??'GET';
        if(init?.body instanceof FormData) {
          sent.push({text:String(init.body.get('content')),bytes:new Uint8Array(await (init.body.get('attachments[]') as Blob).arrayBuffer()),attributes:JSON.parse(String(init.body.get('content_attributes')))});
          return Response.json({id:++nextMessageId});
        }
        const body=init?.body?JSON.parse(String(init.body)):{};
        if(path==='/api/v1/profile')return Response.json({accounts:[{id:1,role:'administrator'}]});
        if(path.endsWith('/inboxes')&&method==='POST')return Response.json({id:31,name:'P4',channel_type:'Channel::Api',secret:'synthetic-callback-secret',webhook_url:body.channel.webhook_url});
        if(path.endsWith('/contacts/search'))return Response.json({payload:[]});
        if(path.endsWith('/contacts'))return Response.json({payload:{contact:{id:41}}});
        if(path.endsWith('/contact_inboxes'))return Response.json({source_id:'synthetic-source'});
        if(path.endsWith('/conversations'))return Response.json({id:51});
        if(path.endsWith('/messages')&&method==='POST'){sent.push({text:body.content,attributes:body.content_attributes});return Response.json({id:++nextMessageId});}
        if(method==='PATCH')return Response.json({});
        throw new Error('Unexpected synthetic mirror route '+path);
      }};
    const media=createMediaStore({encryptionKey:options.encryptionKey,transact:options.transact,async download(){return {bytes:new Uint8Array([1,2,3]),mimeType:'image/png',kind:'image' as const,fileName:'synthetic.png'};}});
    options.media=media;
    const service=createChatwootService(options);
    await service.bindAccount(h.org,{accountId:1,token:'synthetic-account-token'});
    await service.connect(h.org,{channelId:h.channel,name:'P4'});
    return {sent,media,worker:createChatwootWorker(options)};
  }
  it('espelha saída externa em Chatwoot com origem explícita e sem outbox WhatsApp',async()=>{
    const h=await harness(),m=await mirror(h);
    await h.qr.ingest(h.channel,h.auth,h.payload('mirror-external-text'));
    await m.worker.runOnce(h.org);
    expect(m.sent).toEqual([{text:'[Saída observada no WhatsApp]\nSaída sintética',attributes:expect.objectContaining({jrc_broker_message_origin:'EXTERNAL_OBSERVED'})}]);
    expect((await h.transact(tx=>tx.query('SELECT * FROM messaging_outbox WHERE organization_id=$1',[h.org]))).rows).toHaveLength(0);
  });
  it('espelha mídia externa com bytes privados e legenda de origem explícita',async()=>{
    const h=await harness(),m=await mirror(h);
    await h.qr.ingest(h.channel,h.auth,h.payload('mirror-external-media',true,{imageMessage:{caption:'Mídia sintética'}}));
    await m.media.runOnce(h.org);
    await m.worker.runOnce(h.org);
    expect(m.sent).toEqual([{text:'[Saída observada no WhatsApp]\nMídia sintética',bytes:new Uint8Array([1,2,3]),attributes:expect.objectContaining({jrc_broker_message_origin:'EXTERNAL_OBSERVED'})}]);
  });
});
