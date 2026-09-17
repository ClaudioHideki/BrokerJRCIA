import { Pool } from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { EvolutionMessagingClient, type MediaKind } from '@jrc/providers';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { createPostgresMessagingRepository } from '../../src/modules/messaging/repository.js';
import { createQrMessagingService, ensureQrChannel } from '../../src/modules/messaging/qr-service.js';
import { createChatwootService, chatwootEnvironment, readChatwootAccount, type ChatwootOptions } from '../../src/modules/integrations/chatwoot-service.js';
import { createChatwootWorker } from '../../src/modules/integrations/chatwoot-worker.js';
import { createMediaStore } from '../../src/modules/messaging/media-store.js';
let db: IsolatedPostgresDatabase, pool: Pool, org: string, channel: string, integration: string;
let qr: ReturnType<typeof createQrMessagingService>, chatwoot: ReturnType<typeof createChatwootService>, options: ChatwootOptions, media: ReturnType<typeof createMediaStore>;
const repo = createPostgresMessagingRepository(), signing = 'synthetic-signing-key-at-least-32-characters';
const kinds = ['text', 'image', 'audio', 'video', 'document', 'sticker'] as const;
const types: Record<MediaKind, string> = { image: 'image/png', audio: 'audio/ogg', video: 'video/mp4', document: 'application/pdf', sticker: 'image/webp' };
let kind: typeof kinds[number] = 'text', remoteMessageId = 3000;
const mediaBytes = () => new Uint8Array(Buffer.from(`SYNTHETIC-BYTES-${kind}`));
const mirrorCalls: { text?: string; bytes?: Uint8Array; mimeType?: string }[] = [], engineCalls: { path: string; body: Record<string, unknown> }[] = [];
// Byte fixtures test transport fidelity, not playback or acceptance by a real phone.
const engine = new EvolutionMessagingClient({ baseUrl: 'https://engine.example.test', apiKey: 'synthetic-private', instanceKey: 'synthetic',
  async fetch(input, init) {
    const path = new URL(String(input)).pathname, body = JSON.parse(String(init?.body));
    engineCalls.push({ path, body });
    if (path.includes('getBase64')) return Response.json({ base64: Buffer.from(mediaBytes()).toString('base64'), mimetype: types[kind as MediaKind], fileName: `synthetic-${kind}` });
    return Response.json({ key: { id: `synthetic-upstream-${kind}` } });
  } });
beforeAll(async () => {
  const admin = requireTestDatabaseAdminUrl(); db = await createIsolatedPostgresDatabase(admin);
  await withGlobalRoleLock(admin, () => runMigrations(db.connectionString));
  pool = new Pool({ connectionString: connectionStringForRole(db.connectionString, 'jrc_app') });
  org = await runInAdminTransaction(db.pool, async tx => {
    const id = (await createOrganization(tx, { name: 'Media Matrix', slug: 'media-matrix' })).id;
    const user = (await tx.query("INSERT INTO users(email,password_hash) VALUES('media-matrix@example.test','synthetic') RETURNING id")).rows[0].id;
    await tx.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')", [id, user]); return id;
  });
  channel = await withOrganizationTransaction(pool, org, async tx => {
    const provider = (await tx.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','Synthetic') RETURNING id", [org])).rows[0].id;
    const instance = (await tx.query("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'Synthetic','synthetic','CONNECTED') RETURNING id", [org, provider])).rows[0].id;
    return (await ensureQrChannel(tx, org, instance)).id;
  });
  const transact: ChatwootOptions['transact'] = (id, work) => withOrganizationTransaction(pool, id, work);
  qr = createQrMessagingService({ baseUrl: 'https://engine.example.test', apiKey: 'synthetic', signingKey: signing, webhookOrigin: 'https://broker.example.test', transact,
    async resolveChannel(id) { const row = (await pool.query('SELECT * FROM resolve_qr_channel($1)', [id])).rows[0]; return row && { organizationId: row.organization_id, instanceId: row.instance_id }; } });
  options = { baseUrl: 'https://chatwoot.example.test', publicOrigin: 'https://broker.example.test', encryptionKey: Buffer.alloc(32, 11).toString('base64'),
    controlEnabled: false, embedEnabled: false, transact, mediaOrigins: ['https://media.example.test'],
    async resolveIntegration(id) { return (await pool.query('SELECT * FROM resolve_chatwoot_integration($1)', [id])).rows[0]?.organization_id; },
    async fetch(input, init) {
      const url = new URL(String(input)), method = init?.method ?? 'GET';
      if (url.origin === 'https://media.example.test') {
        expect(new Headers(init?.headers).has('api_access_token')).toBe(false);
        return new Response(new Uint8Array(mediaBytes()), { headers: { 'Content-Type': types[kind as MediaKind] } });
      }
      if (init?.body instanceof FormData) {
        const blob = init.body.get('attachments[]') as Blob;
        mirrorCalls.push({ bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: blob.type }); return Response.json({ id: 1000 + kinds.indexOf(kind) });
      }
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.pathname === '/api/v1/profile') return Response.json({ accounts: [{ id: 1, role: 'administrator' }] });
      if (url.pathname.endsWith('/inboxes') && method === 'POST') return Response.json({ id: 31, name: 'Matrix', channel_type: 'Channel::Api', secret: signing, webhook_url: body.channel.webhook_url });
      if (url.pathname.endsWith('/contacts/search')) return Response.json({ payload: [] });
      if (url.pathname.endsWith('/contacts')) return Response.json({ payload: { contact: { id: 41 } } });
      if (url.pathname.endsWith('/contact_inboxes')) return Response.json({ source_id: 'synthetic-source' });
      if (url.pathname.endsWith('/conversations')) return Response.json({ id: 51 });
      if (url.pathname.endsWith('/conversations/51')) return Response.json({ id: 51, account_id: 1, inbox_id: 31, meta: { sender: { id: 41, phone_number: '+12025550123' } } });
      if (url.pathname.endsWith('/messages') && method === 'GET') return Response.json({ payload: [{ id: remoteMessageId, attachments: [{ id: remoteMessageId, account_id: 1, message_id: remoteMessageId, file_type: kind === 'document' ? 'file' : kind === 'sticker' ? 'image' : kind, data_url: `https://media.example.test/synthetic-${kind}` }] }] });
      if (url.pathname.endsWith('/messages') && method === 'POST') { mirrorCalls.push({ text: body.content }); return Response.json({ id: 1000 }); }
      if (method === 'PATCH') return Response.json({});
      throw new Error('Unexpected synthetic Chatwoot route');
    } };
  media = createMediaStore({ encryptionKey: options.encryptionKey, transact, async download(asset) {
    if (asset.source === 'QR') return engine.downloadMedia(String(asset.descriptor.messageId));
    const account = (await transact(org, tx => readChatwootAccount(tx, org)))!;
    return chatwootEnvironment(options).client(account).downloadAttachment(1, 31, 51, Number(asset.descriptor.messageId), Number(asset.descriptor.attachmentId));
  } }); options.media = media; chatwoot = createChatwootService(options);
  await chatwoot.bindAccount(org, { accountId: 1, token: 'synthetic-private-account' });
  integration = (await chatwoot.connect(org, { channelId: channel, name: 'Matrix' })).connections[0]!.id;
});
afterAll(async () => { await pool?.end(); await db?.dispose(); });
async function drain() {
  for (let i = 0; i < 20; i++) {
    const pending = await options.transact(org, tx => tx.query("SELECT id FROM integration_jobs WHERE organization_id=$1 AND status IN ('PENDING','RUNNING','UNKNOWN','FAILED')", [org]));
    if (!pending.rowCount) return;
    await createChatwootWorker(options).runOnce(org);
  }
  throw new Error('Synthetic transport queue did not drain');
}
it.each(kinds)('transports %s both directions with persistent deduplication and no Dashboard App', async next => {
  kind = next; remoteMessageId = 3000 + kinds.indexOf(kind); mirrorCalls.length = 0; engineCalls.length = 0;
  const event = { event: 'messages.upsert', instance: 'synthetic', data: { key: { id: `matrix-${kind}`, remoteJid: '12025550123@s.whatsapp.net' },
    messageTimestamp: Math.floor(Date.now() / 1000), message: kind === 'text' ? { conversation: 'Synthetic text' } : { [kind + 'Message']: { fileName: `synthetic-${kind}` } } } };
  const auth = 'Bearer ' + createHmac('sha256', signing).update(`qr-webhook\0${org}\0${channel}`).digest('base64url');
  await qr.ingest(channel, auth, event); await qr.ingest(channel, auth, event);
  if (kind !== 'text') await media.runOnce(org);
  await drain();
  expect(mirrorCalls).toEqual([kind === 'text' ? { text: 'Synthetic text' } : { bytes: mediaBytes(), mimeType: types[kind] }]);
  const payload = { event: 'message_created', id: remoteMessageId, account: { id: 1 }, inbox: { id: 31 }, conversation: { id: 51 }, message_type: 'outgoing', private: false,
    content: kind === 'text' ? 'Synthetic reply' : '', ...(kind === 'text' ? {} : { attachments: [{ id: remoteMessageId, file_type: kind === 'document' ? 'file' : kind === 'sticker' ? 'image' : kind }] }) };
  const body = Buffer.from(JSON.stringify(payload)), timestamp = String(Math.floor(Date.now() / 1000));
  const signature = 'sha256=' + createHmac('sha256', signing).update(`${timestamp}.`).update(body).digest('hex');
  await chatwoot.ingest(integration, body, timestamp, signature); await chatwoot.ingest(integration, body, timestamp, signature); await drain();
  if (kind !== 'text') await media.runOnce(org);
  const claim = (await options.transact(org, tx => repo.claimOutgoing(tx, { organizationId: org, workerId: randomUUID(), now: new Date(), leaseMs: 120000, limit: 10 }))); expect(claim).toHaveLength(1);
  const outgoing = claim[0]!;
  expect((await options.transact(org, tx => repo.validateClaim(tx, { organizationId: org, messageId: outgoing.message.id, leaseToken: outgoing.leaseToken }))).eligible).toBe(true);
  const sent = outgoing.message.content.type === 'TEXT' ? await engine.sendText(outgoing.contact.externalId, outgoing.message.content.text) :
    await engine.sendMedia(outgoing.contact.externalId, await media.read(org, outgoing.message.content.type === 'MEDIA' ? outgoing.message.content.mediaId : 'invalid'));
  expect(sent.upstreamMessageId).toBe(`synthetic-upstream-${kind}`);
  const call = engineCalls.at(-1)!;
  expect(call.path).toContain(kind === 'text' ? '/message/sendText/' : kind === 'sticker' ? '/message/sendSticker/' : '/message/sendMedia/');
  if (kind !== 'text') expect(Buffer.from(String(call.body[kind === 'sticker' ? 'sticker' : 'media']), 'base64')).toEqual(Buffer.from(mediaBytes()));
  await options.transact(org, tx => repo.completeSend(tx, { organizationId: org, messageId: outgoing.message.id, leaseToken: outgoing.leaseToken, outcome: { state: 'SENT', upstreamMessageId: sent.upstreamMessageId } }));
  await drain();
  expect((await chatwoot.status(org))).toMatchObject({ controlEnabled: false, embedEnabled: false });
  expect((await options.transact(org, tx => tx.query('SELECT id FROM chatwoot_embed_apps'))).rows).toEqual([]);
});
