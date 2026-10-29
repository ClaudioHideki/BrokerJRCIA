// Loopback-only HTTP contracts. Services are synthetic; this is not a durability/provider test.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateUploadMedia } from '@jrc/providers';
import { buildPublicDocument } from './public-api.mjs';
import { buildMediaPostman } from './postman-media.mjs';

const fixture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3aQAAAAASUVORK5CYII=', 'base64');
const unavailable = () => Object.assign(new Error('Synthetic resource unavailable'), { status: 404 });

export async function createMediaContractHarness({ buildApp } = {}) {
  buildApp ??= (await import('../../apps/api/dist/app.js')).buildApp;
  const source = JSON.parse(await readFile(new URL('../../docs/api/openapi.json', import.meta.url), 'utf8'));
  const collection = buildMediaPostman(buildPublicDocument(source, 'messaging'));
  const organizationId = randomUUID(), apiKeyId = randomUUID(), channelId = randomUUID(), mediaId = randomUUID(), conversationId = randomUUID();
  const key = 'synthetic-local-media-contract-key';
  const folder = await mkdtemp(join(tmpdir(), 'jrc-postman-media-'));
  const file = join(folder, 'synthetic-image.png');
  const observations = { uploads: 0, reads: 0, admissions: 0, providerSends: 0, requests: [] };
  let metadata, closed;
  const authority = (organization, channel, apiKey) => {
    if (organization !== organizationId || channel !== channelId || apiKey !== apiKeyId) throw unavailable();
  };
  const app = buildApp({ nodeEnv: 'test', loggerDestination: { write() {} },
    passwordVerifierInitializer: async () => ({ async verifyPasswordOrDummy() { return false; } }),
    messaging: {
      jwtSecret: 'synthetic-only-local-media-contract-jwt-secret',
      authenticateApiKey: async raw => raw === key ? { organizationId, apiKeyId, scopes: ['media:upload', 'media:send', 'messaging:send'] } : null,
      resolveCurrentRole: async () => 'OWNER',
      service: {
        async uploadPartnerMedia(organization, channel, input, apiKey) {
          authority(organization, channel, apiKey);
          validateUploadMedia(input);
          if (!Buffer.from(input.bytes).equals(fixture)) throw Object.assign(new Error('Only synthetic fixture allowed'), { status: 422 });
          if (metadata) throw Object.assign(new Error('One synthetic upload only'), { status: 409 });
          metadata = { id: mediaId, channelId, status: 'READY', kind: input.kind, fileName: input.fileName,
            mimeType: input.mimeType, byteSize: input.bytes.length, sha256: createHash('sha256').update(input.bytes).digest('hex') };
          observations.uploads++;
          return { ...metadata };
        },
        async getPartnerMedia(organization, channel, id, apiKey) {
          authority(organization, channel, apiKey);
          if (!metadata || id !== mediaId) throw unavailable();
          observations.reads++;
          return { ...metadata };
        },
        async sendPartnerMedia(organization, channel, input, _idempotencyKey, apiKey) {
          authority(organization, channel, apiKey);
          if (!metadata || input.mediaId !== mediaId || input.conversationId !== conversationId) throw unavailable();
          if (observations.admissions) throw Object.assign(new Error('One synthetic admission only'), { status: 409 });
          observations.admissions++;
          return { id: randomUUID(), conversationId, direction: 'OUTGOING', state: 'ACCEPTED', text: input.caption ?? '',
            media: { id: mediaId, kind: metadata.kind, fileName: metadata.fileName } };
        },
      },
    },
  });
  app.addHook('onResponse', async (request, reply) => { observations.requests.push({ method: request.method, path: request.url, status: reply.statusCode }); });
  const close = () => closed ??= (async () => { await app.close(); await rm(file, { force: true }); await rmdir(folder); })();
  try {
    await writeFile(file, fixture, { flag: 'wx' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const origin = 'http://127.0.0.1:' + app.server.address().port;
    return { app, origin, collection, observations, close,
      variables: { broker_origin: origin, jrc_api_key: key, channel_id: channelId, media_id: mediaId, conversation_id: conversationId,
        idempotency_key: randomUUID(), media_file_path: file, media_mime: 'image/png', media_kind: 'image',
        media_name: encodeURIComponent('synthetic image.png'), caption_json: JSON.stringify('Synthetic caption'), allow_media_upload: 'false', allow_media_send: 'false' } };
  } catch (error) { await close(); throw error; }
}

async function runFolder(newman, harness, index, overrides = {}) {
  const values = { ...harness.variables, ...overrides };
  const summary = await new Promise((done, fail) => newman.run({ collection: structuredClone(harness.collection),
    folder: [harness.collection.item[index].name], environment: { name: 'SYNTHETIC LOOPBACK ONLY',
      values: Object.entries(values).map(([key, value]) => ({ key, value, enabled: true })) },
    iterationCount: 1, timeout: 20000, timeoutRequest: 3000, timeoutScript: 2000, ignoreRedirects: true, reporters: [],
  }, (error, result) => error ? fail(error) : done(result)));
  return { folder: harness.collection.item[index].name, requests: summary.run.stats.requests.total,
    assertions: summary.run.stats.assertions.total, failures: summary.run.failures.map(failure => ({ at: failure.at, message: failure.error.message })),
    responses: summary.run.executions.filter(execution => execution.response).map(execution => ({ status: execution.response.code, body: JSON.parse(execution.response.stream.toString()) })) };
}

export async function runMediaContractNewman({ newman, buildApp } = {}) {
  assert.equal(typeof newman?.run, 'function', 'Pinned Newman 6.2.3 runtime required');
  const harness = await createMediaContractHarness({ buildApp });
  const guards = [];
  try {
    for (const [name, index, overrides] of [
      ['upload-disabled-by-default', 0, {}], ['send-disabled-by-default', 2, {}],
      ['missing-local-file', 0, { allow_media_upload: 'true', media_file_path: '' }],
      ['invalid-idempotency-key', 0, { allow_media_upload: 'true', idempotency_key: 'invalid' }],
      ['invalid-origin-path', 0, { allow_media_upload: 'true', broker_origin: harness.origin + '/not-an-origin' }],
      ['invalid-caption-json', 2, { allow_media_send: 'true', caption_json: 'invalid-json' }],
    ]) {
      const before = harness.observations.requests.length;
      const result = await runFolder(newman, harness, index, overrides);
      assert.equal(harness.observations.requests.length, before, name + ' must not reach HTTP');
      assert.equal(result.requests, 0, name + ' must skip the request');
      // Newman skipRequest() can stop execution before the following throw; zero HTTP is the guard evidence.
      guards.push({ name, blocked: true, httpRequests: 0, runnerFailures: result.failures.length });
    }
    // Deliberate, separate folder executions. The collection itself never copies IDs or chains sends.
    const upload = await runFolder(newman, harness, 0, { allow_media_upload: 'true', idempotency_key: randomUUID() });
    assert.deepEqual(upload.responses.map(response => response.status), [201]);
    assert.deepEqual(upload.failures, []);
    assert.equal(harness.observations.admissions, 0, 'Upload must not send');
    const returnedMediaId = upload.responses[0].body.id;
    const state = await runFolder(newman, harness, 1, { media_id: returnedMediaId });
    assert.deepEqual(state.responses.map(response => response.status), [200]);
    assert.deepEqual(state.failures, []);
    assert.equal(state.responses[0].body.status, 'READY');
    assert.equal(harness.observations.admissions, 0, 'State query must not send');
    const send = await runFolder(newman, harness, 2, { allow_media_send: 'true', media_id: returnedMediaId, idempotency_key: randomUUID() });
    assert.deepEqual(send.responses.map(response => response.status), [202]);
    assert.deepEqual(send.failures, []);
    assert.equal(send.responses[0].body.state, 'ACCEPTED');
    assert.equal(harness.observations.requests.length, 3, 'Exactly three HTTP requests are allowed');
    assert.deepEqual([harness.observations.uploads, harness.observations.reads, harness.observations.admissions], [1, 1, 1]);
    return { mode: 'LOCAL_HTTP_CONTRACTS_SYNTHETIC_SERVICES', newman: '6.2.3', guards,
      folders: [upload, state, send].map(({ responses, ...result }) => ({ ...result, statuses: responses.map(response => response.status) })),
      httpRequests: harness.observations.requests, uploads: 1, reads: 1, admissions: 1, providerSends: 0, fixtureRemoved: true };
  } finally { await harness.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const flag = process.argv.indexOf('--newman-module');
  if (flag < 0 || !process.argv[flag + 1]) throw new Error('Pass --newman-module with the local newman@6.2.3 directory');
  const require = createRequire(import.meta.url), modulePath = resolve(process.argv[flag + 1]);
  assert.equal(require(join(modulePath, 'package.json')).version, '6.2.3', 'Only newman@6.2.3 is supported');
  const result = await runMediaContractNewman({ newman: require(modulePath) });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
