import { access, readFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { buildApp } from '../apps/api/src/app.js';
import { createMediaContractHarness } from '../scripts/docs/postman-media-contract-harness.mjs';

const open = [];
afterEach(async () => { await Promise.all(open.splice(0).map(harness => harness.close())); });
async function start() { const harness = await createMediaContractHarness({ buildApp }); open.push(harness); return harness; }
function headers(values) {
  return { 'X-JRC-API-Key': values.jrc_api_key, 'Idempotency-Key': values.idempotency_key,
    'Content-Type': 'application/octet-stream', 'X-JRC-Media-Mime': 'image/png', 'X-JRC-Media-Kind': 'image', 'X-JRC-Media-Name': values.media_name };
}

it('binds only loopback and leaves both collection and prepared environment writes disabled', async () => {
  const h = await start();
  expect(h.app).toBeDefined();
  expect(h.app.server.address().address).toBe('127.0.0.1');
  expect(h.collection.item).toHaveLength(3);
  expect(h.collection.variable.find(item => item.key === 'jrc_api_key').value).toBe('');
  expect(h.collection.variable.filter(item => item.key.startsWith('allow_')).map(item => item.value)).toEqual(['false', 'false']);
  expect(h.variables.allow_media_upload).toBe('false');
  expect(h.variables.allow_media_send).toBe('false');
  await access(h.variables.media_file_path);
  await h.close();
  await expect(access(h.variables.media_file_path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('uses the real authentication and recipient schema before the synthetic admission boundary', async () => {
  const h = await start(), v = h.variables;
  expect(h.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const url = `${h.origin}/v1/messaging/channels/${v.channel_id}/partner-media`;
  expect((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': v.idempotency_key },
    body: JSON.stringify({ conversationId: v.conversation_id, mediaId: v.media_id }) })).status).toBe(401);
  const invalid = await fetch(url, { method: 'POST', headers: { ...headers(v), 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: v.conversation_id, mediaId: v.media_id, objectKey: 'must-not-accept-storage-keys' }) });
  expect(invalid.status).toBe(400);
  expect(h.observations.admissions).toBe(0);
});

it('reads the temporary binary fixture through real routes and admits only one synthetic send', async () => {
  const h = await start(), v = h.variables;
  expect(h.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const prefix = `${h.origin}/v1/messaging/channels/${v.channel_id}`;
  const bytes = await readFile(v.media_file_path);
  const upload = await fetch(prefix + '/media', { method: 'POST', headers: headers(v), body: bytes });
  expect(upload.status).toBe(201);
  const metadata = await upload.json();
  expect(metadata).toMatchObject({ status: 'READY', kind: 'image', mimeType: 'image/png', fileName: 'synthetic image.png', byteSize: 68 });
  expect(metadata.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(h.observations.admissions).toBe(0);
  const state = await fetch(prefix + '/media/' + metadata.id, { headers: { 'X-JRC-API-Key': v.jrc_api_key } });
  expect(state.status).toBe(200);
  expect(await state.json()).toEqual(metadata);
  const send = () => fetch(prefix + '/partner-media', { method: 'POST', headers: { ...headers(v), 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: v.conversation_id, mediaId: metadata.id, caption: 'Synthetic caption' }) });
  const accepted = await send();
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toMatchObject({ conversationId: v.conversation_id, state: 'ACCEPTED', text: 'Synthetic caption' });
  expect((await send()).status).toBe(409);
  expect(h.observations).toMatchObject({ uploads: 1, reads: 1, admissions: 1, providerSends: 0 });
});
