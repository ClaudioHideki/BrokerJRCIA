import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildPublicDocument, buildReadOnlyPostman } from '../scripts/docs/public-api.mjs';

const source = JSON.parse(await readFile(new URL('../docs/api/openapi.json', import.meta.url), 'utf8'));
describe('public partner contract', () => {
  it('publishes separate private upload, metadata and canonical media-send contracts with explicit key scopes', () => {
    const contract = buildPublicDocument(source, 'messaging'), prefix = '/v1/messaging/channels/{id}';
    const upload = contract.paths[prefix + '/media']?.post;
    expect(upload).toBeDefined();
    expect(upload.security).toEqual([{ jrcApiKeyAuth: [] }]);
    expect(upload.requestBody.content['application/octet-stream'].schema).toMatchObject({ type: 'string', format: 'binary', maxLength: 16 * 1024 * 1024 });
    expect(upload.responses['201']).toBeDefined(); expect(upload.description).toContain('media:upload');
    const get = contract.paths[prefix + '/media/{mediaId}']?.get;
    expect(get.security).toEqual([{ jrcApiKeyAuth: [] }]); expect(get.description).toContain('não envia');
    const send = contract.paths[prefix + '/partner-media']?.post;
    expect(send.security).toEqual([{ jrcApiKeyAuth: [] }]); expect(send.description).toContain('messaging:send + media:send');
    expect(send.description).toContain('UNKNOWN');
    expect(contract.info.description).not.toContain('não envio de mídia');
  });
  it('distinguishes authorized new enrollment from legacy approval and pair-only reconnection', () => {
    const contract = buildPublicDocument(source, 'chatwoot'), base = '/v1/integrations/chatwoot/control/connections/{integrationId}';
    expect(contract.info.description).toContain('GET não aprova identidade');
    expect(contract.paths[base + '/pair'].post.description).toContain('primeira identidade exige também chatwoot:manage');
    expect(contract.paths[base + '/status'].get.description).toContain('GET nunca aprova identidade');
    expect(contract.paths[base + '/confirm-identity'].post.description).toContain('legado');
    expect(contract.paths['/v1/integrations/chatwoot/control/onboarding'].get.description).toContain('Lista até 50 operações persistidas');
  });
  it('documents the manage scope actually required to discover Chatwoot control resources', () => {
    const operation = buildPublicDocument(source, 'chatwoot').paths['/v1/integrations/chatwoot/control/resources'].get;
    expect(operation.description).toContain('Escopo da chave: chatwoot:manage.');
    expect(operation.description).not.toContain('Escopo da chave: chatwoot:read.');
  });
  it('documents self-service messaging and signed events separately from optional Chatwoot', () => {
    const messaging = buildPublicDocument(source, 'messaging');
    expect(messaging.paths['/v1/messaging/instances/{id}/partner-activate'].post.security).toEqual([{ jrcApiKeyAuth: [] }]);
    expect(messaging.paths['/v1/messaging/channels/{id}/partner-text'].post.security).toEqual([{ jrcApiKeyAuth: [] }]);
    expect(messaging.paths['/v1/messaging/channels/{id}/text']).toBeUndefined();
    expect(messaging.paths['/v1/messaging/media/{id}'].get.security).toEqual([{bearerAuth:[]},{jrcApiKeyAuth:[]}]);
    const events = buildPublicDocument(source, 'events');
    expect(events.paths['/v1/partner-webhooks'].post.parameters).toContainEqual(expect.objectContaining({name:'idempotency-key',required:true}));
    expect(events.paths['/v1/partner-events'].get.responses['200'].content['application/json'].schema).toBeDefined();
    expect(Object.keys(events.paths)).toHaveLength(4);
  });
  it('publishes instance operations and the required provider-account discovery with original guards', () => {
    const contract = buildPublicDocument(source, 'instances');
    expect(Object.values(contract.paths).reduce((n, item) => n + Object.keys(item).length, 0)).toBe(7);
    expect(contract.paths['/v1/provider-accounts'].get.security).toEqual(source.paths['/v1/provider-accounts'].get.security);
    expect(contract.servers).toEqual([{ url: '/', description: 'Esta instalação do Broker JRC' }]);
    expect(contract.paths['/v1/instances'].get.security).toEqual(source.paths['/v1/instances'].get.security);
    expect(contract.paths['/v1/instances/{id}/workspace']).toBeUndefined();
    expect(contract.paths['/v1/instances/{id}/settings']).toBeUndefined();
  });
  it('explains every public operation without modifying its runtime request or response contract', () => {
    for (const profile of ['instances', 'messaging', 'events', 'chatwoot']) {
      const contract = buildPublicDocument(source, profile);
      for (const [path, methods] of Object.entries(contract.paths)) for (const [method, operation] of Object.entries(methods)) {
        expect(operation.summary, method + path).toBeTruthy();
        expect(operation.description, method + path).toContain('Escopo');
        expect(operation.responses).toEqual(source.paths[path][method].responses);
        expect(operation.requestBody).toEqual(source.paths[path][method].requestBody);
      }
    }
  });
  it('keeps account-bound Chatwoot control separate from messaging and administrative issuers', () => {
    const contract = buildPublicDocument(source, 'chatwoot');
    expect(Object.values(contract.paths).reduce((n, item) => n + Object.keys(item).length, 0)).toBe(15);
    expect(contract.paths['/v1/integrations/chatwoot/control/context'].get).toBeDefined();
    expect(contract.paths['/v1/integrations/chatwoot/control/connections/{integrationId}/campaign-intents'].post.security).toEqual([{jrcApiKeyAuth:[]}]);
    expect(Object.keys(contract.paths).some(p => p.includes('credentials') || p.includes('takeovers'))).toBe(false);
    expect(contract.info.description).toContain('Chatwoot');
  });
  it('retains every transitive reference and only required security schemes', () => {
    const contract = buildPublicDocument(source, 'instances');
    const check = value => {
      if (!value || typeof value !== 'object') return;
      if (value.$ref) {
        let resolved = contract;
        for (const part of value.$ref.slice(2).split('/')) resolved = resolved?.[part.replaceAll('~1', '/').replaceAll('~0', '~')];
        expect(resolved, value.$ref).toBeDefined();
      }
      for (const item of Object.values(value)) check(item);
    };
    check(contract);
    expect(Object.keys(contract.components.securitySchemes).sort()).toEqual(['bearerAuth', 'jrcApiKeyAuth']);
    expect(contract.components.securitySchemes.platformSession).toBeUndefined();
  });
  it('fails generation if a required route disappears instead of documenting a fabricated API', () => {
    const changed = structuredClone(source);
    delete changed.paths['/v1/instances/{id}/connect'];
    expect(() => buildPublicDocument(changed, 'instances')).toThrow('/v1/instances/{id}/connect');
    expect(() => buildPublicDocument(source, 'unknown')).toThrow('PROFILE');
  });
  it('does not mutate the canonical document', () => {
    const before = JSON.stringify(source);
    buildPublicDocument(source, 'instances');
    expect(JSON.stringify(source)).toBe(before);
  });
  it('exports only explicit GET requests with an empty tenant key', () => {
    const result = buildReadOnlyPostman(buildPublicDocument(source, 'chatwoot'));
    expect(result.item).toHaveLength(8);
    expect(result.item.every(item => item.request.method === 'GET')).toBe(true);
    expect(result.variable.find(item => item.key === 'jrc_api_key').value).toBe('');
    expect(result.item.every(item => item.request.header.some(header => header.key === 'X-JRC-API-Key'))).toBe(true);
  });
});
