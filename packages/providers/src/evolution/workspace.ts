import type { ProviderContext } from '../contracts/types.js';
import { EvolutionClient, evolutionProviderError, type EvolutionClientOptions, type EvolutionFetch } from './client.js';

export type InstanceSettings = {
  rejectCall: boolean;
  msgCall: string;
  groupsIgnore: boolean;
  alwaysOnline: boolean;
  readMessages: boolean;
  readStatus: boolean;
  syncFullHistory: boolean;
};

export interface ProviderWorkspaceSnapshot {
  profile: { name: string | null; phone: string | null; state: string | null };
  counts: { contacts: number | null; chats: number | null; messages: number | null };
  settings: InstanceSettings | null;
}

const booleanSettings = ['rejectCall', 'groupsIgnore', 'alwaysOnline', 'readMessages', 'readStatus', 'syncFullHistory'] as const;
const responseLimit = 1_048_576;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseSettings(value: unknown): InstanceSettings | null {
  const data = record(value);
  if (!data || booleanSettings.some((key) => typeof data[key] !== 'boolean')
    || typeof data.msgCall !== 'string' || data.msgCall.length > 2_000) return null;
  return {
    rejectCall: data.rejectCall as boolean, msgCall: data.msgCall,
    groupsIgnore: data.groupsIgnore as boolean, alwaysOnline: data.alwaysOnline as boolean,
    readMessages: data.readMessages as boolean, readStatus: data.readStatus as boolean,
    syncFullHistory: data.syncFullHistory as boolean,
  };
}

function boundedString(value: unknown, limit: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= limit ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function encodedKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0 || key.length > 200 || key === '.' || key === '..') {
    throw evolutionProviderError('INVALID_PROVIDER_CONTEXT');
  }
  return encodeURIComponent(key);
}

// Limit bytes before EvolutionClient buffers or parses JSON. pipeThrough also
// cancels a stalled response body when the operation deadline/caller aborts.
function boundedFetch(fetch: EvolutionFetch): EvolutionFetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (!response.body) return response;
    let bytes = 0;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > responseLimit) throw evolutionProviderError('PROVIDER_INVALID_RESPONSE');
        controller.enqueue(chunk);
      },
    }), init?.signal ? { signal: init.signal } : {});
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export class EvolutionWorkspaceClient {
  readonly #client: EvolutionClient;

  constructor(options: EvolutionClientOptions) {
    this.#client = new EvolutionClient({ ...options, fetch: boundedFetch(options.fetch ?? globalThis.fetch) });
  }

  async read(context: ProviderContext, instanceKey: string): Promise<ProviderWorkspaceSnapshot> {
    const key = encodedKey(instanceKey);
    const operation = this.#client.beginOperation(context, 10_000);
    const response = await operation.request({ method: 'GET', path: `/instance/fetchInstances?instanceName=${key}` });
    if (!response.found || !Array.isArray(response.body)) throw evolutionProviderError('PROVIDER_INVALID_RESPONSE');
    const matches = response.body.map(record).filter((row) => row?.name === instanceKey);
    if (matches.length !== 1) throw evolutionProviderError('PROVIDER_INVALID_RESPONSE');
    const row = matches[0]!;
    if (!row) throw evolutionProviderError('PROVIDER_INVALID_RESPONSE');
    let settings = parseSettings(row.Setting);
    if (!settings) {
      const found = await operation.request({ method: 'GET', path: `/settings/find/${key}` });
      settings = found.found ? parseSettings(found.body) : null;
    }
    const counts = record(row._count);
    const phone = typeof row.ownerJid === 'string' ? /^([1-9][0-9]{6,14})@s\.whatsapp\.net$/.exec(row.ownerJid)?.[1] ?? null : null;
    return {
      profile: { name: boundedString(row.profileName, 256), phone, state: boundedString(row.connectionStatus, 64) },
      counts: { contacts: count(counts?.Contact), chats: count(counts?.Chat), messages: count(counts?.Message) },
      settings,
    };
  }

  async updateSettings(context: ProviderContext, instanceKey: string, settings: InstanceSettings): Promise<void> {
    const key = encodedKey(instanceKey);
    const payload = parseSettings(settings);
    if (!payload) throw evolutionProviderError('INVALID_PROVIDER_CONTEXT');
    const operation = this.#client.beginOperation(context, 10_000);
    const current = await operation.request({ method: 'GET', path: `/settings/find/${key}` });
    const currentSettings = current.found ? record(current.body) : null;
    // Upstream setSettings clears the in-memory voice token when it is omitted.
    // Do not roundtrip secrets or mutate instances with that integration enabled.
    if (!currentSettings || !parseSettings(currentSettings)
      || (currentSettings.wavoipToken !== undefined && currentSettings.wavoipToken !== null && currentSettings.wavoipToken !== '')) {
      throw evolutionProviderError('PROVIDER_REQUEST_FAILED');
    }
    const result = await operation.request({ method: 'POST', path: `/settings/set/${key}`, body: payload });
    const envelope = result.found ? record(record(result.body)?.settings) : null;
    const confirmed = parseSettings(envelope?.settings);
    if (envelope?.instanceName !== instanceKey || !confirmed
      || confirmed.msgCall !== payload.msgCall || booleanSettings.some((field) => confirmed[field] !== payload[field])) {
      throw evolutionProviderError('PROVIDER_INVALID_RESPONSE');
    }
  }
}
