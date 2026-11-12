// Explicit image gate, mounted read-only inside the pinned candidate. This is
// not a WhatsApp session or production-host test. The transport is synthetic.
import assert from 'node:assert/strict';
import { createCipheriv, createHmac, hkdfSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getMediaKeys } from '/evolution/node_modules/baileys/lib/Utils/messages-media.js';
import { createBaileysHistoryMediaDownloader } from '/evolution/jrc-origin/history-media-download.mjs';

assert.equal(process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED, 'false');
assert.notEqual(process.getuid(), 0);
const dependency = JSON.parse(await readFile('/evolution/node_modules/baileys/package.json', 'utf8'));
assert.equal(dependency.version, '7.0.0-rc.9');
const receipt = JSON.parse(await readFile('/evolution/jrc-engine-build.json', 'utf8'));
assert.equal(receipt.deliveryOwnership, 'UNPROVEN');
assert.equal(receipt.sourceCommit, 'fa09d37892cdbb1d65a250155d293d92230c5b30');

const cases = [], key = Buffer.alloc(32, 71), signal = AbortSignal.timeout(10000);
for (const [mediaType, type, info] of [
  ['IMAGE', 'image', 'WhatsApp Image Keys'],
  ['AUDIO', 'audio', 'WhatsApp Audio Keys'],
  ['VIDEO', 'video', 'WhatsApp Video Keys'],
  ['DOCUMENT', 'document', 'WhatsApp Document Keys'],
  ['STICKER', 'image', 'WhatsApp Image Keys'],
]) {
  // Derive independently from the protocol, then check the actual installed
  // Baileys implementation rather than another injected derivation fixture.
  const expanded = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), Buffer.from(info), 112));
  const expected = { iv: expanded.subarray(0, 16), cipherKey: expanded.subarray(16, 48), macKey: expanded.subarray(48, 80) };
  const actual = await getMediaKeys(key, type);
  for (const part of ['iv', 'cipherKey', 'macKey']) assert.deepEqual(Buffer.from(actual[part]), expected[part]);
  const clear = Buffer.from(`synthetic pinned-library historical ${mediaType.toLowerCase()} bytes`);
  const cipher = createCipheriv('aes-256-cbc', expected.cipherKey, expected.iv);
  const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
  const mac = createHmac('sha256', expected.macKey).update(expected.iv).update(encrypted).digest().subarray(0, 10);
  const body = Buffer.concat([encrypted, mac]);
  let fetches = 0;
  const descriptor = { mediaType, directPath: '/synthetic/history.enc', mediaKey: key.toString('base64') };
  const download = createBaileysHistoryMediaDownloader({ getMediaKeys, fetch: async (url, options) => {
    assert.equal(url, 'https://mmg.whatsapp.net/synthetic/history.enc');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    fetches++;
    return new Response(body, { headers: { 'content-length': String(body.length) } });
  } });
  const chunks = [];
  for await (const chunk of await download(descriptor, { signal })) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), clear);
  assert.equal(fetches, 1);
  const corrupt = Buffer.from(body); corrupt[corrupt.length - 1] ^= 1;
  const rejected = createBaileysHistoryMediaDownloader({ getMediaKeys, fetch: async () => new Response(corrupt) });
  await assert.rejects(async () => {
    for await (const _ of await rejected(descriptor, { signal })) { /* no custody is acknowledged */ }
  }, /HISTORY_SOURCE_MEDIA_INTEGRITY/u);
  cases.push({ mediaType, derivation: true, authenticatedDownload: true, corruptMacRejected: true });
  expanded.fill(0); clear.fill(0); encrypted.fill(0); body.fill(0); corrupt.fill(0);
}
key.fill(0);
console.log(JSON.stringify({ kind: 'PINNED_IMAGE_MEDIA_CRYPTO_GATE', library: dependency.version,
  sourceCommit: receipt.sourceCommit, network: 'none', transport: 'synthetic', productionHost: false,
  actualWhatsAppSession: false, ownership: receipt.deliveryOwnership, cases }));
