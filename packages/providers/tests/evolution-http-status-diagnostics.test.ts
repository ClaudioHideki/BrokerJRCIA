import { expect, it } from 'vitest';
import { EvolutionGroupsClient, EvolutionWorkspaceClient, evolutionProviderError, type ProviderContext } from '../src/index.js';

const context: ProviderContext = { organizationId: 'synthetic-org', requestId: 'synthetic-request',
  deadline: new Date('2030-01-01'), signal: new AbortController().signal };
const canary = 'secret-body token https://private.invalid/120000000000001@g.us';

it.each([401, 404, 429, 500])('preserves non2xx status %i internally without exposing upstream data or changing serialized errors', async status => {
  for (const operation of ['workspace', 'groups'] as const) {
    const options = { baseUrl: 'http://engine.test', apiKey: 'secret-api',
      fetch: async () => new Response(canary, { status, headers: { 'x-secret': canary } }) };
    const error = await (operation === 'workspace' ? new EvolutionWorkspaceClient(options).read(context, 'synthetic')
      : new EvolutionGroupsClient(options).list(context, 'synthetic')).catch(error => error);
    expect(error).toMatchObject({ name: 'EvolutionProviderError', code: 'PROVIDER_REQUEST_FAILED', message: 'PROVIDER_REQUEST_FAILED', httpStatus: status });
    expect(JSON.parse(JSON.stringify(error))).toEqual({ name: 'EvolutionProviderError', code: 'PROVIDER_REQUEST_FAILED' });
    expect(String(error)).not.toContain('secret');
    expect(JSON.stringify(error)).not.toContain('secret');
  }
});

it('leaves transport failures without an invented HTTP status', () => {
  expect(evolutionProviderError('PROVIDER_TIMEOUT')).not.toHaveProperty('httpStatus');
});
