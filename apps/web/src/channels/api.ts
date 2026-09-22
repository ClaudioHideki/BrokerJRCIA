import {
  ChannelListV1Schema,
  ChannelV1Schema,
  CreateChannelResponseV1Schema,
  PairChannelResponseV1Schema,
  type BindChannelDestinationV1,
  type ChannelV1,
  type CreateChannelV1,
} from '@jrc/contracts';
import { ApiClientError, type ApiClient } from '../api/client.js';

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiClientError('O serviço retornou um canal inválido.', 502);
  return result.data;
}

export async function listChannels(client: ApiClient) {
  return parse(ChannelListV1Schema, await client.request<unknown>('/v1/channels'));
}
export async function getChannel(client: ApiClient, id: string) {
  return parse(ChannelV1Schema, await client.request<unknown>(`/v1/channels/${encodeURIComponent(id)}`));
}
export async function createChannel(client: ApiClient, input: CreateChannelV1, idempotencyKey: string) {
  return parse(CreateChannelResponseV1Schema, await client.request<unknown>('/v1/channels', {
    method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(input),
  }));
}
export async function pairChannel(client: ApiClient, id: string, idempotencyKey: string) {
  return parse(PairChannelResponseV1Schema, await client.request<unknown>(`/v1/channels/${encodeURIComponent(id)}/pair`, {
    method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: '{}',
  }));
}
export async function bindChannelDestination(client: ApiClient, id: string, input: BindChannelDestinationV1): Promise<ChannelV1> {
  return parse(ChannelV1Schema, await client.request<unknown>(`/v1/channels/${encodeURIComponent(id)}/destination`, {
    method: 'PUT', body: JSON.stringify(input),
  }));
}
