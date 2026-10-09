import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Client } from 'pg';

const moduleUrl = new URL('../../src/commands/operational-status.ts', import.meta.url);
const subject = () => import(moduleUrl.href);
const environment = {
  AUTOMATION_RUNTIME_V2_ENABLED: 'true', EVOLUTION_BASE_URL: 'http://evolution:8080',
  DATABASE_URL: 'postgresql://user:private-password@db.example.test:5432/private-db',
  JWT_SECRET: 'private-secret-not-printed', EVOLUTION_API_KEY: 'private-engine-key',
};
const ready = () => Promise.resolve(Response.json({ status: 'ready' }));
const deps = () => ({
  environment: { ...environment }, probeDatabase: async () => ({ reachable: true, compatible: true, version: '16.4' }),
  fetchReady: (_url: string, _init?: RequestInit) => ready(), now: () => new Date('2026-10-07T16:00:00.000Z'), nodeVersion: 'v24.19.0',
  memoryUsage: () => ({ rss: 100000000, heapTotal: 20000000, heapUsed: 12000000 }),
});
afterEach(() => vi.useRealTimers());

it('reports only sanitized container observations when every required local check succeeds', async () => {
  const { collectOperationalStatus } = await subject();
  const report = await collectOperationalStatus(deps());
  expect(report).toMatchObject({
    schemaVersion: 1, status: 'READY', checkedAt: '2026-10-07T16:00:00.000Z', nodeVersion: 'v24.19.0',
    flags: { AUTOMATION_RUNTIME_V2_ENABLED: true }, evolution: { configured: true, protocol: 'http', host: 'evolution', port: 8080 },
    db: { reachable: true, version: '16.4' }, schema: { compatible: true },
    readiness: { status: 'READY', httpStatus: 200 },
    memory: { rssBytes: 100000000, heapTotalBytes: 20000000, heapUsedBytes: 12000000 },
    scope: 'CONTAINER_PROCESS', capacityValidated: false, errors: [],
  });
  expect(report.schema.baseline).toMatch(/^\d{4}_[a-z_]+$/);
  const serialized = JSON.stringify(report);
  for (const secret of ['private-password', 'private-db', 'private-secret', 'private-engine-key', 'db.example.test']) expect(serialized).not.toContain(secret);
});

it('returns partial even when HTTP 200 says ready if the structural schema is incompatible', async () => {
  const { collectOperationalStatus } = await subject();
  const fixture = deps(); fixture.probeDatabase = async () => ({ reachable: true, compatible: false, version: '16.4' });
  const report = await collectOperationalStatus(fixture);
  expect(report.status).toBe('PARTIAL'); expect(report.schema.compatible).toBe(false);
  expect(report.readiness.status).toBe('READY'); expect(report.errors).toContain('SCHEMA_INCOMPATIBLE');
});

it.each(['false', undefined, 'TRUE', 'private-invalid-flag'])('does not coerce runtime flag %s to enabled', async value => {
  const { collectOperationalStatus } = await subject();
  const fixture = deps(); fixture.environment.AUTOMATION_RUNTIME_V2_ENABLED = value as string;
  const report = await collectOperationalStatus(fixture);
  expect(report.status).toBe('PARTIAL');
  expect(report.flags.AUTOMATION_RUNTIME_V2_ENABLED).toBe(value === 'false' ? false : null);
  expect(JSON.stringify(report)).not.toContain('private-invalid-flag');
});

it.each(['https://user:private-password@engine.test', 'https://engine.test?token=private-token', 'https://engine.test#private-fragment', 'file:///private-path', 'bad-private-url'])('never exposes an unsafe Evolution URL (%s)', async value => {
  const { collectOperationalStatus } = await subject();
  const fixture = deps(); fixture.environment.EVOLUTION_BASE_URL = value;
  const report = await collectOperationalStatus(fixture);
  expect(report.evolution).toEqual({ configured: false }); expect(report.status).toBe('PARTIAL');
  expect(JSON.stringify(report)).not.toContain('private-');
});

it('discards Evolution paths and all readiness response fields except the known status', async () => {
  const { collectOperationalStatus } = await subject();
  const fixture = deps(); fixture.environment.EVOLUTION_BASE_URL = 'https://engine.test/private-path';
  fixture.fetchReady = async () => Response.json({ status: 'ready', token: 'private-token', error: 'private-error' });
  const report = await collectOperationalStatus(fixture);
  expect(report.evolution).toEqual({ configured: true, protocol: 'https', host: 'engine.test' });
  expect(report.status).toBe('READY'); expect(JSON.stringify(report)).not.toContain('private-');
});

it('fetches only the fixed loopback readiness URL with redirect rejection and an abort signal', async () => {
  const { collectOperationalStatus } = await subject();
  const fixture = deps(); const requests: Array<{ url: string; init?: RequestInit }> = [];
  fixture.fetchReady = async (url: string, init?: RequestInit) => { requests.push({ url, init }); return Response.json({ status: 'ready' }); };
  await collectOperationalStatus(fixture);
  expect(requests).toHaveLength(1); expect(requests[0]?.url).toBe('http://127.0.0.1:3000/ready');
  expect(requests[0]?.init).toMatchObject({ redirect: 'error', cache: 'no-store' });
  expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
});

it.each([
  [new Response('<html>private-error</html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'READINESS_INVALID_RESPONSE'],
  [new Response('{private-invalid-json', { status: 200, headers: { 'content-type': 'application/json' } }), 'READINESS_INVALID_RESPONSE'],
  [Response.json({ status: 'unavailable' }), 'READINESS_NOT_READY'],
  [Response.json({ status: 'ready' }, { status: 503 }), 'READINESS_NOT_READY'],
  [new Response('x'.repeat(4097), { status: 200, headers: { 'content-type': 'application/json' } }), 'READINESS_BODY_TOO_LARGE'],
])('does not treat an invalid or negative endpoint response as global readiness', async (response, code) => {
  const { collectOperationalStatus } = await subject();
  const fixture = deps(); fixture.fetchReady = async () => response.clone();
  const report = await collectOperationalStatus(fixture);
  expect(report.status).toBe('PARTIAL'); expect(report.readiness.status).not.toBe('READY');
  expect(report.errors).toContain(code); expect(JSON.stringify(report)).not.toContain('private-');
});

it('bounds streamed readiness bodies even without a Content-Length header', async () => {
  const { collectOperationalStatus } = await subject();
  const fixture = deps();
  fixture.fetchReady = async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(2048)); controller.enqueue(new Uint8Array(2049)); controller.close();
  } }), { headers: { 'content-type': 'application/json' } });
  const report = await collectOperationalStatus(fixture);
  expect(report.errors).toContain('READINESS_BODY_TOO_LARGE'); expect(report.status).toBe('PARTIAL');
});

it('times out after three seconds even when the injected fetch never settles', async () => {
  const { collectOperationalStatus } = await subject(); vi.useFakeTimers();
  const fixture = deps(); let signal: AbortSignal | null | undefined;
  fixture.fetchReady = async (_url: string, init?: RequestInit) => { signal = init?.signal; return new Promise<Response>(() => {}); };
  const pending = collectOperationalStatus(fixture);
  await vi.advanceTimersByTimeAsync(3000);
  const report = await pending;
  expect(report.readiness.status).toBe('UNAVAILABLE'); expect(report.errors).toContain('READINESS_TIMEOUT');
  expect(signal?.aborted).toBe(true); expect(report.status).toBe('PARTIAL');
});

it('cancels the readiness stream when its body stalls past the timeout', async () => {
  const { collectOperationalStatus } = await subject(); vi.useFakeTimers();
  const fixture = deps(); let cancelled = false;
  fixture.fetchReady = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { 'content-type': 'application/json' },
  });
  const pending = collectOperationalStatus(fixture);
  await vi.advanceTimersByTimeAsync(3000);
  const report = await pending;
  expect(report.errors).toContain('READINESS_TIMEOUT'); expect(report.status).toBe('PARTIAL');
  expect(cancelled).toBe(true);
});

it('omits an invalid HTTP status from an unavailable readiness observation', async () => {
  const { collectOperationalStatus } = await subject();
  const fixture = deps(); fixture.fetchReady = async () => Response.error();
  const report = await collectOperationalStatus(fixture);
  expect(report.readiness).toEqual({ status: 'UNAVAILABLE' });
  expect(report.errors).toContain('READINESS_INVALID_RESPONSE'); expect(report.status).toBe('PARTIAL');
});

it('emits only permitted PostgreSQL error codes and never their diagnostics', async () => {
  const { collectOperationalStatus } = await subject();
  for (const code of ['08006', '28P01', '42501', 'ECONNREFUSED', 'ETIMEDOUT', 'private-invalid-code']) {
    const fixture = deps(); fixture.probeDatabase = async () => { throw Object.assign(new Error('private-db-error'), { code }); };
    const report = await collectOperationalStatus(fixture);
    expect(report.status).toBe('PARTIAL'); expect(report.db.reachable).toBe(false); expect(report.schema.compatible).toBeNull();
    expect(report.errors).toContain(code === 'private-invalid-code' ? 'DATABASE_UNAVAILABLE' : code);
    expect(JSON.stringify(report)).not.toContain('private-');
  }
});

it('uses read-only startup options and fixed metadata queries without letting URL options disable them', async () => {
  const { probeOperationalDatabase } = await subject();
  let connectionOptions = ''; const queries: string[] = []; let closed = false;
  const result = await probeOperationalDatabase('postgresql://user:private-password@db.test/broker?options=-c%20default_transaction_read_only%3Doff', config => {
    const realConstructor = new Client(config) as Client & { connectionParameters: { options: string } };
    connectionOptions = realConstructor.connectionParameters.options;
    return Object.assign(new EventEmitter(), {
      connect: async () => {}, end: async () => { closed = true; },
      query: async (sql: string) => { queries.push(sql); return { rows: sql === 'SHOW server_version' ? [{ server_version: '16.4 (private-build-detail)' }] : [{ ready: true }] }; },
    });
  });
  expect(connectionOptions).toContain('default_transaction_read_only=on'); expect(connectionOptions).not.toContain('read_only=off');
  expect(connectionOptions).toContain('statement_timeout=3000');
  expect(queries).toHaveLength(2); expect(queries[0]).toBe('SHOW server_version');
  expect(queries[1]?.trimStart().startsWith('SELECT')).toBe(true);
  expect(result).toEqual({ reachable: true, compatible: true, version: '16.4' }); expect(closed).toBe(true);
  expect(JSON.stringify(result)).not.toContain('private-');
});

it('returns a sanitized partial DB probe on denied metadata access and closes the client', async () => {
  const { probeOperationalDatabase } = await subject(); let closed = false;
  const result = await probeOperationalDatabase(environment.DATABASE_URL, () => Object.assign(new EventEmitter(), {
    connect: async () => {}, query: async () => { throw Object.assign(new Error('private-query-error'), { code: '42501' }); },
    end: async () => { closed = true; },
  }));
  expect(result).toEqual({ reachable: true, compatible: null, code: '42501' }); expect(closed).toBe(true);
  expect(JSON.stringify(result)).not.toContain('private-');
});

it('does not create a database connection when DATABASE_URL is absent', async () => {
  const { probeOperationalDatabase } = await subject(); let created = false;
  const result = await probeOperationalDatabase(undefined, () => { created = true; throw new Error('must not connect'); });
  expect(result).toEqual({ reachable: false, compatible: null, code: 'DATABASE_URL_REQUIRED' }); expect(created).toBe(false);
});

it.each(['connect', 'version-query', 'schema-query', 'end'] as const)('captures Client error events during %s and never reports a compatible schema', async phase => {
  const { probeOperationalDatabase, runOperationalStatusCommand } = await subject();
  let escaped = false; let closed = false; let queryCount = 0;
  const client = Object.assign(new EventEmitter(), {
    connect: async () => { if (phase === 'connect') await emitFailure(); },
    query: async (sql: string) => {
      queryCount++;
      if ((phase === 'version-query' && queryCount === 1) || (phase === 'schema-query' && queryCount === 2)) await emitFailure();
      return { rows: sql === 'SHOW server_version' ? [{ server_version: '16.4' }] : [{ ready: true }] };
    },
    end: async () => { if (phase === 'end') await emitFailure(); closed = true; },
  });
  function emitFailure() {
    // Catch only to make the pre-fix RED safe for Vitest: an unhandled emitter would otherwise crash the process.
    return new Promise<void>(resolve => queueMicrotask(() => {
      try { client.emit('error', Object.assign(new Error('private-socket-password'), { code: '08006' })); }
      catch { escaped = true; }
      resolve();
    }));
  }
  const result = await probeOperationalDatabase(environment.DATABASE_URL, () => client);
  expect(escaped).toBe(false); expect(closed).toBe(true);
  expect(result).toMatchObject({ reachable: phase !== 'connect', compatible: null, code: '08006' });
  if (phase === 'connect') expect(queryCount).toBe(0);
  if (phase === 'version-query') expect(queryCount).toBe(1);
  const fixture = deps(); fixture.probeDatabase = async () => result;
  const output: string[] = []; const stderr: string[] = [];
  expect(await runOperationalStatusCommand(fixture, value => output.push(value), value => stderr.push(value))).toBe(1);
  const serialized = output.join(''); const report = JSON.parse(serialized);
  expect(report.status).toBe('PARTIAL'); expect(report.schema.compatible).toBeNull();
  expect(report.errors).toContain('08006'); expect(serialized).not.toContain('private-'); expect(stderr).toEqual([]);
});

it('sanitizes an unknown Client error emitted during closing even after both queries succeed', async () => {
  const { probeOperationalDatabase } = await subject(); let escaped = false;
  const client = Object.assign(new EventEmitter(), {
    connect: async () => {},
    query: async (sql: string) => ({ rows: sql === 'SHOW server_version' ? [{ server_version: '16.4' }] : [{ ready: true }] }),
    end: async () => {
      await new Promise<void>(resolve => queueMicrotask(() => {
        try { client.emit('error', Object.assign(new Error('private-close-stack'), { code: 'private-code' })); }
        catch { escaped = true; }
        resolve();
      }));
    },
  });
  const result = await probeOperationalDatabase(environment.DATABASE_URL, () => client);
  expect(escaped).toBe(false);
  expect(result).toEqual({ reachable: true, compatible: null, version: '16.4', code: 'DATABASE_UNAVAILABLE' });
  expect(JSON.stringify(result)).not.toContain('private-');
});

it('returns exit one for partial JSON and static stderr for unexpected collector failures', async () => {
  const { runOperationalStatusCommand } = await subject(); const output: string[] = []; const errors: string[] = [];
  const fixture = deps(); fixture.environment.AUTOMATION_RUNTIME_V2_ENABLED = 'false';
  const exit = await runOperationalStatusCommand(fixture, value => output.push(value), value => errors.push(value));
  expect(exit).toBe(1); expect(JSON.parse(output.join('')).status).toBe('PARTIAL'); expect(errors).toEqual([]);
  fixture.now = () => { throw new Error('private-crash'); };
  output.length = 0;
  expect(await runOperationalStatusCommand(fixture, value => output.push(value), value => errors.push(value))).toBe(1);
  expect(output).toEqual([]); expect(errors).toEqual(['OPERATIONAL_STATUS_FAILED\n']);
});

it('returns exit zero only for the complete local report and keeps runtime observations sanitized', async () => {
  const { runOperationalStatusCommand } = await subject(); const output: string[] = [];
  expect(await runOperationalStatusCommand(deps(), value => output.push(value))).toBe(0);
  const report = JSON.parse(output.join('')); expect(report.status).toBe('READY'); expect(report.capacityValidated).toBe(false);
  expect(report.scope).toBe('CONTAINER_PROCESS');
});
