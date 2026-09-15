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
import { createChatwootService, type ChatwootOptions } from '../../src/modules/integrations/chatwoot-service.js';
import { createChatwootWorker } from '../../src/modules/integrations/chatwoot-worker.js';
import { createChatwootProvisioner } from '../../src/modules/integrations/chatwoot-provisioner.js';
import {createMediaStore,registerPendingMedia} from '../../src/modules/messaging/media-store.js';

describe('QR e integração JRC Conversas no PostgreSQL real', () => {
  let db: IsolatedPostgresDatabase, pool: Pool;
  let org: string, other: string, instance: string, channel: string;
  let qr: ReturnType<typeof createQrMessagingService>;
  let chatwoot: ReturnType<typeof createChatwootService>, cwOptions: ChatwootOptions;
  const externalCalls: { path: string; method: string; body: Record<string, unknown> }[] = [];
  const key = 'test-qr-key-'.repeat(4), repo = createPostgresMessagingRepository();
  beforeAll(async () => {
    const admin = requireTestDatabaseAdminUrl();
    db = await createIsolatedPostgresDatabase(admin);
    await withGlobalRoleLock(admin, () => runMigrations(db.connectionString));
    [org, other] = await runInAdminTransaction(db.pool, async tx => {
      const ids = [
        (await createOrganization(tx, { name: 'QR empresa A', slug: 'qr-company-a' })).id,
        (await createOrganization(tx, { name: 'QR empresa B', slug: 'qr-company-b' })).id,
      ];
      for (const id of ids) {
        const user = (await tx.query<{ id: string }>('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id', [`owner-${id}@example.test`, 'test-only-hash'])).rows[0]!;
        await tx.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')", [id, user.id]);
      }
      return [ids[0]!, ids[1]!] as const;
    });
    pool = new Pool({ connectionString: connectionStringForRole(db.connectionString, 'jrc_app') });
    channel = await withOrganizationTransaction(pool, org, async tx => {
      const provider = (await tx.query<{ id: string }>("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','QR JRC') RETURNING id", [org])).rows[0]!.id;
      instance = (await tx.query<{ id: string }>("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'Teste','private-test-engine','CONNECTED') RETURNING id", [org, provider])).rows[0]!.id;
      return (await ensureQrChannel(tx, org, instance)).id;
    });
    qr = createQrMessagingService({ baseUrl: 'https://engine.test', apiKey: 'test-only', signingKey: key, webhookOrigin: 'https://broker.test',
      transact: (id, op) => withOrganizationTransaction(pool, id, op),
      async resolveChannel(id) {
        const row = (await pool.query<{ organization_id: string; instance_id: string }>('SELECT * FROM resolve_qr_channel($1)', [id])).rows[0];
        return row ? { organizationId: row.organization_id, instanceId: row.instance_id } : undefined;
      } });
    cwOptions = { baseUrl: 'https://conversas.test', publicOrigin: 'https://broker.test', encryptionKey: Buffer.alloc(32, 7).toString('base64'),
      transact: (id, op) => withOrganizationTransaction(pool, id, op),
      async resolveIntegration(id) { return (await pool.query<{ organization_id: string }>('SELECT * FROM resolve_chatwoot_integration($1)', [id])).rows[0]?.organization_id; },
      async fetch(input, init) {
        const path = new URL(String(input)).pathname, method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        externalCalls.push({ path, method, body });
        let response: unknown;
        if (path === '/api/v1/profile') response = { accounts: [{ id: 1, role: 'administrator' }] };
        else if (path.endsWith('/inboxes') && method === 'POST') response = { id: 31, name: 'JRC piloto', channel_type: 'Channel::Api', secret: 'cw-signing-secret', webhook_url: (body.channel as { webhook_url: string }).webhook_url };
        else if (path.endsWith('/contacts/search')) response = { payload: [] };
        else if (path.endsWith('/contacts') && method === 'POST') response = { payload: { contact: { id: 41 } } };
        else if (path.endsWith('/contact_inboxes')) response = { source_id: 'contact-source' };
        else if (path.endsWith('/conversations') && method === 'POST') response = { id: 51 };
        else if (path.endsWith('/messages') && method === 'POST') response = { id: 61 };
        else if (method === 'PATCH') response = {};
        else throw new Error('Unexpected Chatwoot call: ' + path);
        return new Response(JSON.stringify(response));
      } };
    chatwoot = createChatwootService(cwOptions);
  });
  afterAll(async () => { await pool?.end(); await db?.dispose(); });
  const auth = () => 'Bearer ' + createHmac('sha256', key).update(`qr-webhook\0${org}\0${channel}`).digest('base64url');
  const payload = () => ({ event: 'messages.upsert', instance: 'private-test-engine', data: { key: { id: 'qr-ingress-1', remoteJid: '15550000001@s.whatsapp.net', fromMe: false }, messageTimestamp: Math.floor(Date.now() / 1000) - 48 * 3600, message: { conversation: 'Oi JRC' } } });
  it('cria canal QR sem campos Meta fictícios e mantém isolamento', async () => {
    expect(await withOrganizationTransaction(pool, org, tx => repo.findChannel(tx, org, channel))).toMatchObject({ provider: 'BAILEYS', instanceId: instance, phoneNumberId: null, wabaId: null });
    expect(await withOrganizationTransaction(pool, other, tx => repo.findChannel(tx, other, channel))).toBeNull();
    await expect(withOrganizationTransaction(pool, other, tx => ensureQrChannel(tx, other, instance))).rejects.toMatchObject({ code: 'QR_INSTANCE_NOT_FOUND' });
  });
  it('rejeita segredo inválido e persiste entrada repetida uma única vez', async () => {
    await expect(qr.ingest(channel, 'Bearer wrong', payload())).rejects.toMatchObject({ status: 401 });
    await qr.ingest(channel, auth(), payload());
    await qr.ingest(channel, auth(), payload());
    const rows = await withOrganizationTransaction(pool, org, tx => tx.query('SELECT id,content FROM messaging_messages WHERE organization_id=$1', [org]));
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].content).toEqual({ type: 'TEXT', text: 'Oi JRC' });
  });
  it('envia texto QR sem exigir janela específica da Meta', async () => {
    const conversation = (await withOrganizationTransaction(pool, org, tx => repo.listConversations(tx, org, channel, 10)))[0]!;
    await withOrganizationTransaction(pool, org, tx => repo.enqueueOutgoing(tx, { id: randomUUID(), organizationId: org, channelId: channel, conversationId: conversation.id,
      source: 'OPERATOR', content: { type: 'TEXT', text: 'Resposta' }, idempotencyKey: 'qr-response-1', bodyHash: 'hash', policy: { requireOptIn: false } }));
    const claim = (await withOrganizationTransaction(pool, org, tx => repo.claimOutgoing(tx, { organizationId: org, workerId: randomUUID(), now: new Date(), leaseMs: 120000, limit: 1 })))[0]!;
    expect(claim.channel.provider).toBe('BAILEYS');
    const checked = await withOrganizationTransaction(pool, org, tx => repo.validateClaim(tx, { organizationId: org, messageId: claim.message.id, leaseToken: claim.leaseToken }));
    expect(checked.eligible).toBe(true);
    await withOrganizationTransaction(pool, org, tx => repo.completeSend(tx, { organizationId: org, messageId: claim.message.id, leaseToken: claim.leaseToken, outcome: { state: 'SENT', upstreamMessageId: 'qr-out-1' } }));
  });
  it('agenda novas empresas sem conceder leitura global de mensagens', async () => {
    const ids = await pool.query('SELECT * FROM messaging_worker_organizations(NULL,100)');
    expect(ids.rows.map(row => row.organization_id)).toEqual(expect.arrayContaining([org, other]));
    expect((await pool.query('SELECT id FROM messaging_messages')).rows).toEqual([]);
  });
  it('revalida desconexão QR imediatamente antes do envio e preserva a fila',async()=>{
    const conversation=(await withOrganizationTransaction(pool,org,t=>repo.listConversations(t,org,channel,10)))[0]!;
    const queued=await withOrganizationTransaction(pool,org,t=>repo.enqueueOutgoing(t,{id:randomUUID(),organizationId:org,channelId:channel,conversationId:conversation.id,source:'OPERATOR',content:{type:'TEXT',text:'Retomar quando reconectar'},idempotencyKey:'qr-offline',bodyHash:'offline-hash',policy:{requireOptIn:false}}));
    const claim=(await withOrganizationTransaction(pool,org,t=>repo.claimOutgoing(t,{organizationId:org,workerId:randomUUID(),now:new Date(),leaseMs:120000,limit:1})))[0]!;
    await qr.ingest(channel,auth(),{event:'connection.update',instance:'private-test-engine',data:{state:'close'}});
    const check=await withOrganizationTransaction(pool,org,t=>repo.validateClaim(t,{organizationId:org,messageId:queued.message.id,leaseToken:claim.leaseToken}));
    expect(check).toEqual({eligible:false,reason:'QR_CHANNEL_DISCONNECTED'});
    const pending=await withOrganizationTransaction(pool,org,t=>t.query('SELECT state FROM messaging_messages WHERE id=$1',[queued.message.id]));
    expect(pending.rows[0].state).toBe('ACCEPTED');
    await qr.ingest(channel,auth(),{event:'connection.update',instance:'private-test-engine',data:{state:'open'}});
    await withOrganizationTransaction(pool,org,t=>t.query("UPDATE messaging_messages SET state='FAILED' WHERE id=$1",[queued.message.id]));
    await withOrganizationTransaction(pool,org,t=>t.query('DELETE FROM messaging_outbox WHERE message_id=$1',[queued.message.id]));
  });
  it('impede que duas empresas reivindiquem a mesma conta Chatwoot', async () => {
    await withOrganizationTransaction(pool, org, tx => tx.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id) VALUES($1,'https://conversas.test',1)", [org]));
    await expect(withOrganizationTransaction(pool, other, tx => tx.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id) VALUES($1,'https://conversas.test',1)", [other]))).rejects.toMatchObject({ code: '23505' });
    const visible = await withOrganizationTransaction(pool, other, tx => tx.query('SELECT * FROM chatwoot_accounts'));
    expect(visible.rows).toEqual([]);
  });
  it('persiste mensagem QR no JRC Conversas e recebe resposta autenticada uma única vez', async () => {
    await chatwoot.bindAccount(org, { accountId: 1, token: 'cw-tenant-token' });
    const configured = await chatwoot.connect(org, { channelId: channel, name: 'JRC piloto' });
    const integration = configured.connections[0]!;
    expect(integration).toMatchObject({ status: 'READY', inboxId: 31 });
    expect(JSON.stringify(configured)).not.toContain('cw-tenant-token');
    expect(JSON.stringify(configured)).not.toContain('cw-signing-secret');
    const next = payload();
    next.data.key.id = 'qr-ingress-2';
    next.data.messageTimestamp = Math.floor(Date.now() / 1000);
    await qr.ingest(channel, auth(), next);
    // A fresh worker recovers the committed job without relying on process memory.
    await createChatwootWorker(cwOptions).runOnce(org);
    const mirrors = externalCalls.filter(c => c.path.endsWith('/messages') && c.method === 'POST');
    expect(mirrors).toHaveLength(1);
    expect(mirrors[0]!.body).toMatchObject({ message_type: 'incoming', content: 'Oi JRC', private: false });
    const raw = Buffer.from(JSON.stringify({ event: 'message_created', id: 71, account: { id: 1 }, inbox: { id: 31 }, conversation: { id: 51, inbox_id: 31 }, message_type: 'outgoing', private: false, content: 'Resposta JRC' }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = 'sha256=' + createHmac('sha256', 'cw-signing-secret').update(timestamp + '.').update(raw).digest('hex');
    await chatwoot.ingest(integration.id, raw, timestamp, signature);
    await chatwoot.ingest(integration.id, raw, timestamp, signature);
    await createChatwootWorker(cwOptions).runOnce(org);
    const replies = await withOrganizationTransaction(pool, org, t => t.query("SELECT id FROM messaging_messages WHERE organization_id=$1 AND idempotency_key='chatwoot:71'", [org]));
    expect(replies.rows).toHaveLength(1);
    const jobs = await chatwoot.jobs(org);
    expect(jobs.data.some(job => job.kind === 'CHATWOOT_REPLY' && job.status === 'SUCCEEDED')).toBe(true);
    expect((await chatwoot.status(other)).connections).toEqual([]);
  });
  it('provisiona conta e usuário por empresa com etapas persistidas e sem duplicação', async () => {
    const calls: string[] = [];
    const options = { ...cwOptions, platformToken: 'platform-test-token', async fetch(input: string | URL | Request, init?: RequestInit) {
      const path = new URL(String(input)).pathname; calls.push(path);
      if (path === '/platform/api/v1/accounts') return Response.json({ id: 2 });
      if (path === '/platform/api/v1/users') return Response.json({ id: 22, access_token: 'tenant-2-token' });
      if (path === '/platform/api/v1/accounts/2/account_users') return Response.json({ user_id: 22, role: 'administrator' });
      if (path === '/api/v1/profile') return Response.json({ accounts: [{ id: 2, role: 'administrator' }] });
      throw new Error('Unexpected provisioning call');
    } };
    const input = { name: 'Cliente B', email: 'client-b@example.test', password: 'Temporary-Test!234' };
    const provisioner = createChatwootProvisioner(options);
    await provisioner.start(other, input);
    await provisioner.resume(other);
    expect((await createChatwootService(options).status(other)).account).toMatchObject({ accountId: 2, status: 'READY' });
    expect(calls.filter(path => path === '/platform/api/v1/accounts')).toHaveLength(1);
    const saved = await withOrganizationTransaction(pool, other, t => t.query('SELECT * FROM chatwoot_provisioning'));
    expect(saved.rows[0]).toMatchObject({ stage: 'DONE', encrypted_input: null });
    expect(JSON.stringify(saved.rows)).not.toContain(input.password);
  });
  it('interrompe provisionamento incerto e exige conciliação antes de novo POST', async () => {
    const id = await runInAdminTransaction(db.pool, async tx => {
      const created = await createOrganization(tx, { name: 'Incerto', slug: 'unknown-provisioning' });
      const owner = (await tx.query("INSERT INTO users(email,password_hash) VALUES('unknown-owner@example.test','test-only-hash') RETURNING id")).rows[0];
      await tx.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')", [created.id, owner.id]);
      return created.id;
    });
    let calls = 0;
    const options = { ...cwOptions, platformToken: 'platform-test-token', async fetch() { calls++; throw new Error('connection lost'); } };
    const provisioner = createChatwootProvisioner(options);
    await expect(provisioner.start(id, { name: 'Incerto', email: 'unknown@example.test', password: 'Temporary-Test!234' })).rejects.toMatchObject({ code: 'CHATWOOT_OUTCOME_UNKNOWN' });
    await expect(provisioner.resume(id)).rejects.toMatchObject({ code: 'PROVISIONING_REQUIRES_RECONCILIATION' });
    expect(calls).toBe(1);
  });
  it('concilia mensagem aceita pelo destino após perda de resposta sem reenviá-la',async()=>{
    for(let i=0;i<8;i++)await createChatwootWorker(cwOptions).runOnce(org);
    let sent:Record<string,unknown>|undefined;let attempts=0;
    const options={...cwOptions,async fetch(input:string|URL|Request,init?:RequestInit){
      const path=new URL(String(input)).pathname;
      if(path.endsWith('/messages')&&init?.method==='POST'){
        attempts++;sent=JSON.parse(String(init.body));throw new Error('Response lost after accept');
      }
      if(path.endsWith('/messages')&&init?.method==='GET')return Response.json({payload:[{id:991,content_attributes:sent?.content_attributes}]});
      return cwOptions.fetch!(input,init);
    }};
    const event=payload();event.data.key.id='qr-reconcile-1';event.data.messageTimestamp=Math.floor(Date.now()/1000);
    await qr.ingest(channel,auth(),event);
    await createChatwootWorker(options).runOnce(org);
    const service=createChatwootService(options);
    const pending=(await service.jobs(org)).data.find(job=>job.status==='UNKNOWN');
    expect(pending).toBeDefined();
    await service.reconcileJob(org,pending!.id,'Conferência do recebimento',991);
    await createChatwootWorker(options).runOnce(org);
    expect(attempts).toBe(1);
    expect((await service.jobs(org)).data.find(job=>job.id===pending!.id)?.status).toBe('SUCCEEDED');
  });
  it('mantém tarefas recebidas durante uma pausa e retoma sem recriar a caixa',async()=>{
    const c=(await chatwoot.status(org)).connections[0]!;
    await chatwoot.setEnabled(org,c.id,false);
    const event=payload();event.data.key.id='qr-paused';event.data.messageTimestamp=Math.floor(Date.now()/1000);
    await qr.ingest(channel,auth(),event);
    const before=externalCalls.length;
    await createChatwootWorker(cwOptions).runOnce(org);
    expect(externalCalls.length).toBe(before);
    expect((await chatwoot.jobs(org)).data.some(j=>j.status==='PENDING')).toBe(true);
    await chatwoot.setEnabled(org,c.id,true);
    await createChatwootWorker(cwOptions).runOnce(org);
    expect(externalCalls.slice(before).filter(c=>c.path.endsWith('/messages')&&c.method==='POST')).toHaveLength(1);
  });
  it('persiste anexo cifrado no banco e recusa leitura por outra empresa',async()=>{
    const bytes=new Uint8Array([137,80,78,71,13,10,26,10]);let downloads=0;
    const store=createMediaStore({encryptionKey:Buffer.alloc(32,8).toString('base64'),transact:cwOptions.transact,async download(asset){downloads++;expect(asset.organization_id).toBe(org);return {bytes,mimeType:'image/png',fileName:'imagem.png',kind:'image'};}});
    const reference={source:'QR' as const,sourceKey:'qr-media-1',kind:'image' as const,fileName:'imagem.png',descriptor:{messageId:'qr-media-1'}};
    const mediaId=await withOrganizationTransaction(pool,org,t=>registerPendingMedia(t,org,channel,reference));
    expect(await withOrganizationTransaction(pool,org,t=>registerPendingMedia(t,org,channel,reference))).toBe(mediaId);
    await store.runOnce(org);
    expect((await store.read(org,mediaId)).bytes).toEqual(bytes);
    await expect(store.read(other,mediaId)).rejects.toMatchObject({code:'MEDIA_NOT_FOUND'});
    const saved=await withOrganizationTransaction(pool,org,t=>t.query('SELECT encrypted_data,status FROM messaging_media WHERE id=$1',[mediaId]));
    expect(saved.rows[0].status).toBe('READY');expect(saved.rows[0].encrypted_data).not.toContain(Buffer.from(bytes).toString('base64'));
    await store.runOnce(org);expect(downloads).toBe(1);
  });
  it('espelha imagem QR e recebe múltiplos anexos sem perder vínculo nem duplicar o webhook',async()=>{
    const bytes=new Uint8Array([137,80,78,71,13,10,26,10]);
    const media=createMediaStore({encryptionKey:cwOptions.encryptionKey,transact:cwOptions.transact,async download(){return {bytes,mimeType:'image/png',fileName:'foto.png',kind:'image'};}});
    const forms:FormData[]=[];
    const options={...cwOptions,media,async fetch(input:string|URL|Request,init?:RequestInit){
      if(init?.body instanceof FormData){forms.push(init.body);return Response.json({id:1001});}
      return cwOptions.fetch!(input,init);
    }};
    await qr.ingest(channel,auth(),{event:'messages.upsert',instance:'private-test-engine',data:{key:{id:'qr-image',remoteJid:'15550000001@s.whatsapp.net'},messageTimestamp:Math.floor(Date.now()/1000),message:{imageMessage:{caption:'Documento recebido'}}}});
    await media.runOnce(org);await createChatwootWorker(options).runOnce(org);
    expect(forms).toHaveLength(1);expect(forms[0]!.get('content')).toBe('Documento recebido');
    const integration=(await chatwoot.status(org)).connections[0]!;
    const body=Buffer.from(JSON.stringify({event:'message_created',id:1002,account:{id:1},inbox:{id:31},conversation:{id:51},message_type:'outgoing',private:false,content:'Arquivos',attachments:[{id:101,file_type:'image'},{id:102,file_type:'image'}]}));
    const timestamp=String(Math.floor(Date.now()/1000));const signature='sha256='+createHmac('sha256','cw-signing-secret').update(`${timestamp}.`).update(body).digest('hex');
    await chatwoot.ingest(integration.id,body,timestamp,signature);
    await chatwoot.ingest(integration.id,body,timestamp,signature);
    await createChatwootWorker(options).runOnce(org);
    const results=await withOrganizationTransaction(pool,org,t=>t.query("SELECT m.content FROM messaging_messages m JOIN chatwoot_messages cm ON cm.organization_id=m.organization_id AND cm.message_id=m.id WHERE cm.remote_message_id=1002"));
    expect(results.rows).toHaveLength(2);expect(results.rows.every(r=>r.content.type==='MEDIA')).toBe(true);
  });
  it('retoma falha comprovadamente anterior ao envio com atraso, mas não repete envio incerto',async()=>{
    const conversation=(await withOrganizationTransaction(pool,org,t=>repo.listConversations(t,org,channel,10)))[0]!;
    await withOrganizationTransaction(pool,org,t=>t.query("UPDATE messaging_messages SET state='FAILED' WHERE organization_id=$1 AND direction='OUTGOING' AND state='ACCEPTED'",[org]));
    await withOrganizationTransaction(pool,org,t=>t.query("DELETE FROM messaging_outbox WHERE organization_id=$1",[org]));
    const queued=await withOrganizationTransaction(pool,org,t=>repo.enqueueOutgoing(t,{id:randomUUID(),organizationId:org,channelId:channel,conversationId:conversation.id,source:'OPERATOR',content:{type:'TEXT',text:'Repetível'},idempotencyKey:'safe-retry',bodyHash:'safe-retry-hash',policy:{requireOptIn:false}}));
    const claim=(await withOrganizationTransaction(pool,org,t=>repo.claimOutgoing(t,{organizationId:org,workerId:randomUUID(),now:new Date(),leaseMs:120000,limit:1})))[0]!;
    await withOrganizationTransaction(pool,org,t=>repo.completeSend(t,{organizationId:org,messageId:queued.message.id,leaseToken:claim.leaseToken,outcome:{state:'FAILED',canonicalErrorCode:'QR_RATE_LIMITED',retrySafe:true}}));
    const after=await withOrganizationTransaction(pool,org,t=>repo.claimOutgoing(t,{organizationId:org,workerId:randomUUID(),now:new Date(Date.now()+120000),leaseMs:120000,limit:1}));
    expect(after[0]?.message.id).toBe(queued.message.id);
    await withOrganizationTransaction(pool,org,t=>repo.validateClaim(t,{organizationId:org,messageId:queued.message.id,leaseToken:after[0]!.leaseToken}));
    await withOrganizationTransaction(pool,org,t=>repo.completeSend(t,{organizationId:org,messageId:queued.message.id,leaseToken:after[0]!.leaseToken,outcome:{state:'UNKNOWN',canonicalErrorCode:'QR_SEND_UNKNOWN'}}));
    expect(await withOrganizationTransaction(pool,org,t=>repo.claimOutgoing(t,{organizationId:org,workerId:randomUUID(),now:new Date(Date.now()+600000),leaseMs:120000,limit:1}))).toEqual([]);
  });
  it('rejeita conteúdo incompleto no banco inclusive mídia sem referência', async () => {
    for (const invalid of [{}, {type:'TEXT'}, {type:'TEMPLATE',name:'missing-fields'}, {type:'MEDIA',kind:'image',fileName:'missing-reference.png'}]) {
      await expect(withOrganizationTransaction(pool,org,t=>t.query(
        'UPDATE messaging_messages SET content=$1 WHERE id=(SELECT id FROM messaging_messages LIMIT 1)', [JSON.stringify(invalid)]
      ))).rejects.toMatchObject({code:'23514'});
    }
  });
  it('só vincula à caixa atendentes existentes na conta da empresa', async () => {
    const connection=(await chatwoot.status(org)).connections[0]!;
    const mutations:unknown[]=[];
    const user={id:501,name:'Atendente',email:'agent@example.test'};
    const service=createChatwootService({...cwOptions,async fetch(input,init){
      const path=new URL(String(input)).pathname;
      if(path.endsWith('/agents')) return Response.json([user]);
      if(path.endsWith('/inbox_members/31')) return Response.json({payload:mutations.length?[user]:[]});
      if(path.endsWith('/inbox_members')&&init?.method==='POST'){mutations.push(JSON.parse(String(init.body)));return Response.json({});}
      throw new Error('Unexpected agent call');
    }});
    await expect(service.addAgents(org,connection.id,[999])).rejects.toMatchObject({code:'CHATWOOT_AGENT_NOT_IN_ACCOUNT'});
    expect(mutations).toEqual([]);
    expect((await service.addAgents(org,connection.id,[501,501])).data).toEqual([{...user,assigned:true}]);
    expect(mutations).toEqual([{inbox_id:31,user_ids:[501]}]);
    await expect(service.agents(other,connection.id)).rejects.toThrow();
    expect(mutations).toHaveLength(1);
  });
  it('valida a conversa e o contato antes de aceitar um primeiro envio criado no atendimento',async()=>{
    const connection=(await chatwoot.status(org)).connections[0]!;
    // Earlier scenarios deliberately leave failed-send mirror tasks. This scenario starts with an idle queue.
    await withOrganizationTransaction(pool,org,t=>t.query("UPDATE integration_jobs SET status='SUCCEEDED',lease_token=NULL,lease_expires_at=NULL WHERE organization_id=$1",[org]));
    const options={...cwOptions,async fetch(input:string|URL|Request,init?:RequestInit){
      const path=new URL(String(input)).pathname;
      if(path.endsWith('/conversations/701'))return Response.json({id:701,account_id:1,inbox_id:31,meta:{sender:{id:801,phone_number:'+15550000999',name:'Contato de teste'}}});
      if(path.endsWith('/contacts/801'))return Response.json({payload:{id:801,phone_number:'+15550000999',contact_inboxes:[{inbox:{id:31},source_id:'source-801'}]}});
      if(path.endsWith('/conversations/702'))return Response.json({id:702,account_id:2,inbox_id:31,meta:{sender:{id:801,phone_number:'+15550000999'}}});
      return cwOptions.fetch!(input,init);
    }};
    for(const [messageId,conversationId] of [[901,701],[902,702]]){
      const raw=Buffer.from(JSON.stringify({event:'message_created',id:messageId,account:{id:1},inbox:{id:31},conversation:{id:conversationId},message_type:'outgoing',private:false,content:'Primeiro atendimento'}));
      const timestamp=String(Math.floor(Date.now()/1000));
      const signature='sha256='+createHmac('sha256','cw-signing-secret').update(timestamp+'.').update(raw).digest('hex');
      await chatwoot.ingest(connection.id,raw,timestamp,signature);
      const worker=createChatwootWorker(options);
      for(let turn=0;turn<3;turn++) await worker.runOnce(org);
    }
    const rows=await withOrganizationTransaction(pool,org,t=>t.query('SELECT remote_message_id FROM chatwoot_messages WHERE remote_message_id IN (901,902)'));
    expect(rows.rows.map(r=>Number(r.remote_message_id))).toEqual([901]);
    expect((await chatwoot.jobs(org)).data.some(j=>j.lastError==='CHATWOOT_BINDING_MISMATCH')).toBe(true);
  });
});
