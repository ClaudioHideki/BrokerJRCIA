import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';
import { buildPublicDocument } from '../scripts/docs/public-api.mjs';
import { buildMediaPostman } from '../scripts/docs/postman-media.mjs';

const source = JSON.parse(await readFile(new URL('../docs/api/openapi.json', import.meta.url)));
const collection = () => buildMediaPostman(buildPublicDocument(source, 'messaging'));
const items = () => collection().item.flatMap(folder => folder.item);
function scriptContext(values) {
  return { variables: { get: key => values[key], replaceIn: value => value.replace(/\{\{([^}]+)\}\}/g, (_, key) => values[key] ?? '') },
    execution: { setNextRequest: vi.fn(), skipRequest: vi.fn() } };
}
it('contains only the three implemented upload/state/send operations and empty credentials', () => {
  const document = collection(), all = items();
  expect(all.map(item => item.request.method)).toEqual(['POST', 'GET', 'POST']);
  expect(document.variable.find(v => v.key === 'jrc_api_key')).toMatchObject({ value: '', type: 'secret' });
  expect(document.variable.find(v => v.key === 'media_file_path').value).toBe('');
  expect(document.variable.filter(v => v.key.startsWith('allow_')).map(v => v.value)).toEqual(['false', 'false']);
  expect(all[0].request.body).toEqual({ mode: 'file', file: { src: '{{media_file_path}}' } });
  expect(all[0].request.header).toContainEqual({ key: 'Content-Type', value: 'application/octet-stream' });
  expect(all[2].request.body.raw).toContain('mediaId');
  expect(all.every(item => item.request.header.some(h => h.key === 'X-JRC-API-Key'))).toBe(true);
  expect(JSON.stringify(document)).not.toContain('Authorization');
});
it('skips each disabled write before requiring files/IDs or allowing HTTP', () => {
  const writes = items().filter(item => item.request.method === 'POST');
  expect(writes).toHaveLength(2);
  for (const item of writes) {
    const pm = scriptContext({});
    expect(() => vm.runInNewContext(item.event.find(e => e.listen === 'prerequest').script.exec.join('\n'), { pm })).toThrow('desabilitada');
    expect(pm.execution.skipRequest).toHaveBeenCalledOnce(); expect(pm.execution.setNextRequest).toHaveBeenCalledWith(null);
    expect(item.event.find(e => e.listen === 'test').script.exec.join('\n')).toContain('setNextRequest(null)');
  }
});
it.each([{ media_file_path: '', idempotency_key: '11111111-1111-4111-8111-111111111111' }, { media_file_path: 'example.png', idempotency_key: 'invalid' }])('rejects missing files or malformed UUID even after explicit upload opt-in: %j', override => {
  const upload = items()[0]; expect(upload).toBeDefined();
  const values = { allow_media_upload: 'true', broker_origin: 'https://broker.example.test', jrc_api_key: 'synthetic', channel_id: '11111111-1111-4111-8111-111111111111',
    media_mime: 'image/png', media_kind: 'image', media_name: 'example.png', ...override };
  const pm = scriptContext(values);
  expect(() => vm.runInNewContext(upload.event.find(e => e.listen === 'prerequest').script.exec.join('\n'), { pm })).toThrow();
  expect(pm.execution.skipRequest).toHaveBeenCalledOnce();
});
it('permits one deliberately configured request without invoking HTTP from the scripts', () => {
  const values = { allow_media_upload: 'true', allow_media_send: 'true', broker_origin: 'http://127.0.0.1:5198', jrc_api_key: 'synthetic',
    channel_id: '11111111-1111-4111-8111-111111111111', media_id: '22222222-2222-4222-8222-222222222222', conversation_id: '33333333-3333-4333-8333-333333333333',
    media_file_path: 'example.png', idempotency_key: '44444444-4444-4444-8444-444444444444', media_mime: 'image/png', media_kind: 'image', media_name: 'example.png', caption_json: '"Example"' };
  for (const item of items()) {
    const pm = scriptContext(values);
    expect(() => vm.runInNewContext(item.event.find(e => e.listen === 'prerequest').script.exec.join('\n'), { pm })).not.toThrow();
    expect(pm.execution.skipRequest).not.toHaveBeenCalled();
  }
});
