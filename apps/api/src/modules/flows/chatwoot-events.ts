import { z } from 'zod';
import { FlowError } from './service.js';

const id = z.number().int().positive();
const message = z.object({
  event: z.literal('message_created'), id, account: z.object({ id }), inbox: z.object({ id }),
  conversation: z.object({ id, inbox_id: id }), private: z.boolean(),
  message_type: z.union([z.string(), z.number()]), content: z.string().max(4096).nullable().optional(),
  sender: z.object({ id, type: z.string(), name: z.string().max(200).optional() }),
});
export type FlowChatwootEvent = {
  kind: 'TURN' | 'HUMAN'; key: string; conversationId: number; messageId: number; text: string; name: string;
};

/** Webhooks are hints, not authorization: the worker also reads the canonical conversation. */
export function parseFlowChatwootEvent(value: unknown, binding: { accountId: number; inboxId: number; botId: number }): FlowChatwootEvent | null {
  if (!value || typeof value !== 'object' || !('event' in value) || value.event !== 'message_created') return null;
  const data = message.parse(value);
  if (data.account.id !== binding.accountId || data.inbox.id !== binding.inboxId || data.conversation.inbox_id !== binding.inboxId)
    throw new FlowError('FLOW_CHATWOOT_BINDING_MISMATCH', 403);
  if (data.private) return null;
  const outgoing = data.message_type === 'outgoing' || data.message_type === 1;
  if (outgoing && data.sender.type.toLowerCase().replace('_', '') === 'agentbot' && data.sender.id === binding.botId) return null;
  if (!outgoing && data.message_type !== 'incoming' && data.message_type !== 0) return null;
  if (!outgoing && (!data.content?.trim() || data.sender.type.toLowerCase() !== 'contact')) return null;
  return { kind: outgoing ? 'HUMAN' : 'TURN', key: 'message:' + data.id, conversationId: data.conversation.id,
    messageId: data.id, text: data.content ?? '', name: data.sender.name ?? 'Cliente' };
}
