import { expect, it } from 'vitest';
import { documentationClientOptions, createRequestGuard } from '../scripts/docs/assets/portal.js';

it('keeps credentials in memory, disables external configuration and never sends console cookies', () => {
  expect(documentationClientOptions).toMatchObject({ persistAuthorization: false, queryConfigEnabled: false, validatorUrl: null, withCredentials: false });
  const guard = createRequestGuard('https://broker.example', { '/v1/instances': { get: {}, post: {} } }, false);
  const result = guard({ url: 'https://broker.example/v1/instances?limit=1', method: 'GET', headers: { Cookie: 'private', 'X-JRC-API-Key': 'fixture' } });
  expect(result.credentials).toBe('omit');
  expect(result.headers.Cookie).toBeUndefined();
  expect(result.headers['X-JRC-API-Key']).toBe('fixture');
});
it('blocks writes until explicitly enabled and rejects routes outside the contract even after opt in', () => {
  const paths = { '/v1/instances/{id}/connect': { post: {} } };
  expect(() => createRequestGuard('https://broker.example', paths, false)({ url: '/v1/instances/a/connect', method: 'POST' })).toThrow('TESTES_DE_ESCRITA_DESATIVADOS');
  const guard = createRequestGuard('https://broker.example', paths, true);
  expect(guard({ url: '/v1/instances/a/connect', method: 'POST' }).credentials).toBe('omit');
  for (const url of ['https://evil.example/v1/instances/a/connect', '/v1/platform/companies', 'https://user:pass@broker.example/v1/instances/a/connect']) {
    expect(() => guard({ url, method: 'POST' })).toThrow('DESTINO_NAO_PERMITIDO');
  }
});
it('does not permit methods absent from the actual operation or ambiguous doubled authentication', () => {
  const guard = createRequestGuard('https://broker.example', { '/v1/instances': { get: {} } }, true);
  expect(() => guard({ url: '/v1/instances', method: 'DELETE' })).toThrow('DESTINO_NAO_PERMITIDO');
  expect(() => guard({ url: '/v1/instances', method: 'GET', headers: { authorization: 'Bearer fixture', 'x-jrc-api-key': 'fixture' } })).toThrow('UMA_CREDENCIAL_POR_REQUISICAO');
});
