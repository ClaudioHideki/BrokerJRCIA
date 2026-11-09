import type { ChannelV1 } from '@jrc/contracts';
import { ApiClientError, type ApiClient } from '../api/client.js';
import { listChannels } from '../channels/api.js';
import { collectNameSearchPages } from '../connections/name-search.js';

export async function setupChannels(client: ApiClient, org: string, signal: AbortSignal): Promise<ChannelV1[]> {
  return collectNameSearchPages(async (cursor, abort) => {
    const page = await listChannels(client, false, { pageSize: 100, ...(cursor ? { cursor } : {}) }, abort);
    if (page.data.some(channel => channel.organizationId !== org)) throw new ApiClientError('O catálogo não corresponde à empresa atual.', 409);
    return { data: page.data, nextCursor: page.nextCursor ?? null };
  }, signal);
}
