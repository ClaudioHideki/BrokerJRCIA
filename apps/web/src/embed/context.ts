export interface EmbedContext { accountId: number; inboxId: number; conversationId: number }
export const isAllowedContextEvent = (event: { origin: string; sourceIsParent: boolean }, expectedOrigin: string) =>
  event.sourceIsParent && event.origin === expectedOrigin && expectedOrigin !== 'null';
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
export function parseAppContext(value: unknown): EmbedContext | null {
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (!serialized || serialized.length > 65536) return null;
    const message = record(JSON.parse(serialized));
    if (message?.event !== 'appContext') return null;
    const conversation = record(record(message.data)?.conversation);
    if (!conversation || !positiveId(conversation.account_id) || !positiveId(conversation.inbox_id) || !positiveId(conversation.id)) return null;
    // Never retain contact/messages/currentAgent, even if the parent sends them.
    return { accountId: conversation.account_id, inboxId: conversation.inbox_id, conversationId: conversation.id };
  } catch { return null; }
}
export const isContextGranted = (context: EmbedContext, session: { accountId: number; connections: readonly { inboxId: number }[] }) =>
  context.accountId === session.accountId && session.connections.some(connection => connection.inboxId === context.inboxId);
