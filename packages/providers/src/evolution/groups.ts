import type { ProviderContext } from '../contracts/types.js';
import {
  EvolutionClient, evolutionProviderError,
  type EvolutionClientOptions, type EvolutionFetch,
} from './client.js';

// Local admission limits, not pagination or limits promised by Evolution.
const maximumResponseBytes = 2_097_152;
const maximumGroups = 2_000;
const operationTimeoutMs = 15_000;
const groupJidPattern = /^\d+(?:-\d+)?@g\.us$/u;

export interface EvolutionGroupCatalogItem {
  groupJid: string;
  subject: string;
  participantCount: number;
  restrict: boolean | null;
  announce: boolean | null;
  isCommunity: boolean | null;
  isCommunityAnnounce: boolean | null;
  linkedParent: string | null;
}

function invalidResponse(): never {
  throw evolutionProviderError('PROVIDER_INVALID_RESPONSE');
}

function groupJid(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || !groupJidPattern.test(value)) invalidResponse();
  return value;
}

function observedBoolean(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') invalidResponse();
  return value;
}

function normalizeGroup(value: unknown): EvolutionGroupCatalogItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidResponse();
  const row = value as Record<string, unknown>;
  if (typeof row.subject !== 'string' || !row.subject.trim() || row.subject.length > 256
    || typeof row.size !== 'number' || !Number.isSafeInteger(row.size) || row.size < 0 || row.size > 100_000) {
    invalidResponse();
  }
  return {
    groupJid: groupJid(row.id), subject: row.subject, participantCount: row.size,
    restrict: observedBoolean(row.restrict), announce: observedBoolean(row.announce),
    isCommunity: observedBoolean(row.isCommunity), isCommunityAnnounce: observedBoolean(row.isCommunityAnnounce),
    linkedParent: row.linkedParent === undefined || row.linkedParent === null ? null : groupJid(row.linkedParent),
  };
}

function encodedKey(key: string): string {
  if (typeof key !== 'string' || !key || key.length > 200 || key === '.' || key === '..') {
    throw evolutionProviderError('INVALID_PROVIDER_CONTEXT');
  }
  return encodeURIComponent(key);
}

// Validate byte admission and UTF-8 before the shared client buffers/parses JSON.
// The same operation signal bounds fetch and the entire response consumption.
function boundedFetch(fetch: EvolutionFetch): EvolutionFetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && (!/^\d+$/u.test(contentLength)
      || !Number.isSafeInteger(Number(contentLength)) || Number(contentLength) > maximumResponseBytes)) {
      void response.body?.cancel().catch(() => undefined);
      // Surface validation at body consumption, preserving the shared client's
      // INVALID_RESPONSE classification instead of disguising it as fetch I/O.
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.error(evolutionProviderError('PROVIDER_INVALID_RESPONSE')); },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    if (!response.body) return response;
    let bytes = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maximumResponseBytes) invalidResponse();
        try { decoder.decode(chunk, { stream: true }); } catch { invalidResponse(); }
        controller.enqueue(chunk);
      },
      flush() {
        try { decoder.decode(); } catch { invalidResponse(); }
      },
    }), init?.signal ? { signal: init.signal } : {});
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/**
 * Catalog read only. Verified against Evolution fa09d378's fetchAllGroups route
 * and Baileys implementation; this does not establish the installed version,
 * participant details, group sending, Meta support or central representation.
 */
export class EvolutionGroupsClient {
  readonly #client: EvolutionClient;

  constructor(options: EvolutionClientOptions) {
    this.#client = new EvolutionClient({ ...options, fetch: boundedFetch(options.fetch ?? globalThis.fetch) });
  }

  async list(context: ProviderContext, instanceKey: string): Promise<EvolutionGroupCatalogItem[]> {
    const key = encodedKey(instanceKey);
    const operation = this.#client.beginOperation(context, operationTimeoutMs);
    const response = await operation.request({ method: 'GET', path: `/group/fetchAllGroups/${key}?getParticipants=false` });
    if (!response.found || !Array.isArray(response.body) || response.body.length > maximumGroups) invalidResponse();
    const items = response.body.map(normalizeGroup);
    if (new Set(items.map(item => item.groupJid)).size !== items.length) invalidResponse();
    return items;
  }
}
