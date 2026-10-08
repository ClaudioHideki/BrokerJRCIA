import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import type { ClientConfig } from 'pg';
import { probeRequiredRuntimeSchema, RUNTIME_SCHEMA_BASELINE } from '../db/runtime-schema.js';

const TIMEOUT_MS = 3000;
const MAX_READY_BYTES = 4096;
const READINESS_URL = 'http://127.0.0.1:3000/ready';
const READ_ONLY_OPTIONS = '-c default_transaction_read_only=on -c statement_timeout=3000';
const DATABASE_CODES = new Set(['08006', '28P01', '42501', 'ECONNREFUSED', 'ETIMEDOUT']);
const DATABASE_STATIC_CODES = new Set(['DATABASE_URL_REQUIRED', 'DATABASE_CONFIGURATION_INVALID', 'DATABASE_UNAVAILABLE']);

interface DatabaseClient {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  connect(): Promise<unknown>;
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<unknown>;
}

interface DatabaseObservation {
  reachable: boolean;
  compatible: boolean | null;
  version?: string;
  code?: string;
}

interface OperationalStatusDependencies {
  environment: Record<string, string | undefined>;
  probeDatabase(): Promise<DatabaseObservation>;
  fetchReady(url: string, init: RequestInit): Promise<Response>;
  now(): Date;
  nodeVersion: string;
  memoryUsage(): { rss: number; heapTotal: number; heapUsed: number };
}

interface ReadinessObservation {
  status: 'READY' | 'NOT_READY' | 'UNAVAILABLE';
  httpStatus?: number;
}

class ReadinessFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function databaseErrorCode(error: unknown): string {
  try {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    return typeof code === 'string' && DATABASE_CODES.has(code) ? code : 'DATABASE_UNAVAILABLE';
  } catch {
    return 'DATABASE_UNAVAILABLE';
  }
}

function databaseVersion(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 256) return undefined;
  return /^(\d{1,3}(?:\.\d{1,3}){0,2})(?:\s|$)/.exec(value)?.[1];
}

// The factory is an internal test seam. The command accepts no SQL, URL or role arguments.
export async function probeOperationalDatabase(
  connectionString: string | undefined,
  createClient: (config: ClientConfig) => DatabaseClient = config => new Client(config),
): Promise<DatabaseObservation> {
  if (!connectionString) return { reachable: false, compatible: null, code: 'DATABASE_URL_REQUIRED' };
  let protectedConnectionString: string;
  try {
    if (connectionString.length > 16384) throw new Error('invalid');
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash) throw new Error('invalid');
    // pg merges URI parameters after ClientConfig, so URI options must also be fixed.
    url.searchParams.set('options', READ_ONLY_OPTIONS);
    url.searchParams.set('statement_timeout', String(TIMEOUT_MS));
    url.searchParams.set('query_timeout', String(TIMEOUT_MS));
    url.searchParams.set('connectionTimeoutMillis', String(TIMEOUT_MS));
    url.searchParams.set('application_name', 'broker_operational_status');
    protectedConnectionString = url.href;
  } catch {
    return { reachable: false, compatible: null, code: 'DATABASE_CONFIGURATION_INVALID' };
  }

  let client: DatabaseClient | undefined;
  let reachable = false;
  let compatible: boolean | null = null;
  let version: string | undefined;
  let code: string | undefined;
  try {
    client = createClient({
      connectionString: protectedConnectionString,
      connectionTimeoutMillis: TIMEOUT_MS,
      query_timeout: TIMEOUT_MS,
      statement_timeout: TIMEOUT_MS,
      options: READ_ONLY_OPTIONS,
      application_name: 'broker_operational_status',
    });
    // Socket failures can arrive outside connect/query promises, including while ending.
    client.on('error', error => { code ??= databaseErrorCode(error); });
    await client.connect();
    if (!code) {
      reachable = true;
      const versionResult = await client.query('SHOW server_version');
      version = databaseVersion(versionResult.rows[0]?.server_version);
      if (!code) {
        const activeClient = client;
        compatible = await probeRequiredRuntimeSchema(async sql => {
          const result = await activeClient.query(sql);
          return { rows: result.rows.map(row => ({ ready: row.ready === true ? true : row.ready === false ? false : null })) };
        });
      }
    }
  } catch (error) {
    code ??= databaseErrorCode(error);
  } finally {
    if (client) {
      try { await client.end(); } catch (error) { code ??= databaseErrorCode(error); }
    }
  }
  return { reachable, compatible: code ? null : compatible, ...(version ? { version } : {}), ...(code ? { code } : {}) };
}

function evolutionObservation(raw: string | undefined): { configured: boolean; protocol?: string; host?: string; port?: number } {
  if (!raw || raw.length > 4096) return { configured: false };
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
      return { configured: false };
    }
    return {
      configured: true, protocol: url.protocol.slice(0, -1), host: url.hostname,
      ...(url.port ? { port: Number(url.port) } : {}),
    };
  } catch {
    return { configured: false };
  }
}

async function boundedReadyBody(response: Response, signal: AbortSignal): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_READY_BYTES) {
    throw new ReadinessFailure('READINESS_BODY_TOO_LARGE');
  }
  if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
    throw new ReadinessFailure('READINESS_INVALID_RESPONSE');
  }
  const reader = response.body.getReader();
  const cancelReader = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancelReader, { once: true });
  if (signal.aborted) cancelReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_READY_BYTES) throw new ReadinessFailure('READINESS_BODY_TOO_LARGE');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new ReadinessFailure('READINESS_INVALID_RESPONSE'); }
  } finally {
    signal.removeEventListener('abort', cancelReader);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readinessObservation(fetchReady: OperationalStatusDependencies['fetchReady']): Promise<{ observation: ReadinessObservation; code?: string }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: Response | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ReadinessFailure('READINESS_TIMEOUT'));
      controller.abort();
    }, TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([
      (async () => {
        response = await fetchReady(READINESS_URL, {
          redirect: 'error', cache: 'no-store', headers: { accept: 'application/json' }, signal: controller.signal,
        });
        if (response.status < 100 || response.status > 599) throw new ReadinessFailure('READINESS_INVALID_RESPONSE');
        if (response.status !== 200) return { observation: { status: 'NOT_READY' as const, httpStatus: response.status }, code: 'READINESS_NOT_READY' };
        const body = await boundedReadyBody(response, controller.signal);
        const isReady = typeof body === 'object' && body !== null && 'status' in body && body.status === 'ready';
        return {
          observation: { status: isReady ? 'READY' as const : 'NOT_READY' as const, httpStatus: response.status },
          ...(!isReady ? { code: 'READINESS_NOT_READY' } : {}),
        };
      })(),
      timeout,
    ]);
    return result;
  } catch (error) {
    const code = error instanceof ReadinessFailure ? error.code : 'READINESS_UNAVAILABLE';
    const httpStatus = response && Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : undefined;
    return { observation: { status: 'UNAVAILABLE', ...(httpStatus !== undefined ? { httpStatus } : {}) }, code };
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }
}

export async function collectOperationalStatus(deps: OperationalStatusDependencies) {
  const checkedAt = deps.now().toISOString();
  if (!/^v\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(deps.nodeVersion)) throw new Error('invalid runtime');
  const memory = deps.memoryUsage();
  if (![memory.rss, memory.heapTotal, memory.heapUsed].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('invalid memory');
  const errors: string[] = [];
  const flagValue = deps.environment.AUTOMATION_RUNTIME_V2_ENABLED;
  const runtimeEnabled = flagValue === 'true' ? true : flagValue === 'false' ? false : null;
  if (runtimeEnabled !== true) errors.push(runtimeEnabled === false ? 'AUTOMATION_RUNTIME_DISABLED' : 'AUTOMATION_RUNTIME_UNKNOWN');
  const evolution = evolutionObservation(deps.environment.EVOLUTION_BASE_URL);
  if (!evolution.configured) errors.push('EVOLUTION_CONFIGURATION_INVALID');

  const [database, readiness] = await Promise.all([
    deps.probeDatabase().catch((error: unknown): DatabaseObservation => ({ reachable: false, compatible: null, code: databaseErrorCode(error) })),
    readinessObservation(deps.fetchReady),
  ]);
  const reachable = database.reachable === true;
  const compatible = database.compatible === true ? true : database.compatible === false ? false : null;
  const version = databaseVersion(database.version);
  if (database.code) errors.push(DATABASE_CODES.has(database.code) || DATABASE_STATIC_CODES.has(database.code) ? database.code : 'DATABASE_UNAVAILABLE');
  else if (!reachable) errors.push('DATABASE_UNAVAILABLE');
  if (compatible !== true) errors.push(compatible === false ? 'SCHEMA_INCOMPATIBLE' : 'SCHEMA_UNAVAILABLE');
  if (readiness.code) errors.push(readiness.code);

  return {
    schemaVersion: 1 as const,
    status: errors.length === 0 ? 'READY' as const : 'PARTIAL' as const,
    checkedAt, nodeVersion: deps.nodeVersion,
    flags: { AUTOMATION_RUNTIME_V2_ENABLED: runtimeEnabled }, evolution,
    schema: { baseline: RUNTIME_SCHEMA_BASELINE, compatible },
    db: { reachable, ...(version ? { version } : {}) }, readiness: readiness.observation,
    memory: { rssBytes: memory.rss, heapTotalBytes: memory.heapTotal, heapUsedBytes: memory.heapUsed },
    scope: 'CONTAINER_PROCESS' as const, capacityValidated: false as const,
    errors: [...new Set(errors)],
  };
}

export async function runOperationalStatusCommand(
  deps: OperationalStatusDependencies,
  writeOutput: (value: string) => unknown = value => process.stdout.write(value),
  writeError: (value: string) => unknown = value => process.stderr.write(value),
): Promise<number> {
  try {
    const report = await collectOperationalStatus(deps);
    writeOutput(`${JSON.stringify(report)}\n`);
    return report.status === 'READY' ? 0 : 1;
  } catch {
    writeError('OPERATIONAL_STATUS_FAILED\n');
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.length !== 2) {
    process.stderr.write('OPERATIONAL_STATUS_USAGE\n');
    process.exitCode = 1;
  } else {
    process.exitCode = await runOperationalStatusCommand({
      environment: process.env,
      probeDatabase: () => probeOperationalDatabase(process.env.DATABASE_URL),
      fetchReady: (url, init) => fetch(url, init),
      now: () => new Date(), nodeVersion: process.version, memoryUsage: () => process.memoryUsage(),
    });
  }
}
