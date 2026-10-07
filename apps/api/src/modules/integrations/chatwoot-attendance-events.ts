import { z } from 'zod';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const scopeId = z.object({ id });
const record = (raw: unknown): Record<string, unknown> => raw !== null && typeof raw === 'object' && !Array.isArray(raw)
  ? raw as Record<string, unknown> : {};

export interface ChatwootEventScope {
  organizationId: string;
  integrationId: string;
  accountId: number;
  inboxId: number;
  /** Supplied only from the current persisted central binding, never webhook metadata. */
  brokerBotId?: number;
}
/** Evidence must come from our persisted message map, never content_attributes supplied in a webhook. */
export interface PersistedBrokerEcho extends ChatwootEventScope {
  remoteConversationId: number;
  remoteMessageId: number;
}
type Assignee = { kind: 'NONE' | 'UNKNOWN' } | { kind: 'HUMAN' | 'EXTERNAL_BOT' | 'BROKER_BOT'; id: number };
type MessageKind = 'HUMAN_PUBLIC' | 'HUMAN_PRIVATE' | 'EXTERNAL_BOT' | 'AUTOMATED_REPLY' |
  'UNVERIFIED_REPLY' | 'BROKER_ECHO' | 'CONTACT_MESSAGE' | 'SYSTEM_MESSAGE';
export type ChatwootAttendanceEvent = {
  kind: MessageKind;
  remoteConversationId: number;
  remoteMessageId: number;
  senderId?: number;
  mayForwardReply: boolean;
  interruptsBot: boolean;
} | {
  kind: 'CONVERSATION_CONTROL';
  remoteConversationId: number;
  remoteUpdatedAt: number | null;
  status: 'open' | 'pending' | 'resolved' | 'snoozed';
  assignee: Assignee;
  teamId: number | null;
  mayForwardReply: false;
  interruptsBot: boolean;
};
const messageSchema = z.object({
  id, account: scopeId, inbox: scopeId,
  conversation: z.object({ id, inbox_id: id.optional(), account: scopeId.optional() }),
  message_type: z.union([z.enum(['incoming', 'outgoing', 'activity', 'template']), z.number().int().min(0).max(3)]),
  private: z.boolean(), sender: z.unknown().optional(), additional_attributes: z.unknown().optional(),
  content_attributes: z.unknown().optional(),
});
const controlSchema = z.object({
  id, account: scopeId, inbox_id: id,
  status: z.enum(['open', 'pending', 'resolved', 'snoozed']),
  updated_at: z.number().finite().nonnegative().nullable().optional(), meta: z.unknown().optional(),
});
function requireScope(accountId: number, inboxId: number, scope: ChatwootEventScope) {
  if (accountId !== scope.accountId || inboxId !== scope.inboxId) throw new Error('CHATWOOT_BINDING_MISMATCH');
}
function assignee(meta: Record<string, unknown>): Assignee {
  if (!Object.hasOwn(meta, 'assignee')) return { kind: 'UNKNOWN' };
  if (meta.assignee === null) {
    if (meta.assignee_type != null) throw new Error('CHATWOOT_CONTROL_INVALID');
    return { kind: 'NONE' };
  }
  const actor = record(meta.assignee);
  const actorId = id.safeParse(actor.id);
  const explicitType = typeof actor.type === 'string' ? actor.type : null;
  const declaredType = meta.assignee_type === 'User' ? 'user' : meta.assignee_type === 'AgentBot' ? 'agent_bot' : null;
  if (explicitType && declaredType && explicitType !== declaredType) throw new Error('CHATWOOT_CONTROL_INVALID');
  if (!actorId.success || (meta.assignee_type != null && !declaredType)) return { kind: 'UNKNOWN' };
  const type = explicitType ?? declaredType;
  return type === 'user' ? { kind: 'HUMAN', id: actorId.data } : type === 'agent_bot'
    ? { kind: 'EXTERNAL_BOT', id: actorId.data } : { kind: 'UNKNOWN' };
}

/**
 * Classifies an already authenticated API Inbox callback. This is not signature verification or a dispatch authorization.
 * A pending event can never resume a session; reconciliation/revisions must decide whether any effect may run.
 * Shapes follow Chatwoot 4.16.2 EventDataPresenter and Message.webhook_data; forks need capability verification.
 */
export function classifyChatwootAttendanceEvent(raw: unknown, scope: ChatwootEventScope,
  echo?: PersistedBrokerEcho): ChatwootAttendanceEvent | null {
  const event = record(raw).event;
  if (event === 'message_created') {
    const message = messageSchema.parse(raw);
    requireScope(message.account.id, message.inbox.id, scope);
    requireScope(message.conversation.account?.id ?? message.account.id, message.conversation.inbox_id ?? message.inbox.id, scope);
    const result = (kind: MessageKind, interruptsBot: boolean, mayForwardReply = false, senderId?: number): ChatwootAttendanceEvent => ({
      kind, remoteConversationId: message.conversation.id, remoteMessageId: message.id,
      ...(senderId === undefined ? {} : { senderId }), mayForwardReply, interruptsBot,
    });
    if (message.message_type === 'incoming' || message.message_type === 0) return result('CONTACT_MESSAGE', false);
    if (message.message_type !== 'outgoing' && message.message_type !== 1) return result('SYSTEM_MESSAGE', false);
    if (echo && echo.organizationId === scope.organizationId && echo.integrationId === scope.integrationId &&
      echo.accountId === scope.accountId && echo.inboxId === scope.inboxId &&
      echo.remoteConversationId === message.conversation.id && echo.remoteMessageId === message.id) return result('BROKER_ECHO', false);
    const sender = record(message.sender), senderId = id.safeParse(sender.id);
    if (!senderId.success) return result('UNVERIFIED_REPLY', true);
    if (sender.type === 'agent_bot') return result('EXTERNAL_BOT', true, !message.private, senderId.data);
    if (sender.type !== 'user') return result('UNVERIFIED_REPLY', true);
    const attributes = record(message.additional_attributes), contentAttributes = record(message.content_attributes);
    if (contentAttributes.automation_rule_id != null || attributes.campaign_id != null) {
      return result('AUTOMATED_REPLY', true, !message.private, senderId.data);
    }
    return result(message.private ? 'HUMAN_PRIVATE' : 'HUMAN_PUBLIC', true, !message.private, senderId.data);
  }
  if (event !== 'conversation_created' && event !== 'conversation_updated' && event !== 'conversation_status_changed') return null;
  const conversation = controlSchema.parse(raw);
  requireScope(conversation.account.id, conversation.inbox_id, scope);
  const meta = record(conversation.meta);
  let assigned=assignee(meta);
  if(assigned.kind==='EXTERNAL_BOT'&&assigned.id===scope.brokerBotId)assigned={kind:'BROKER_BOT',id:assigned.id};
  const teamId = meta.team == null ? null : id.parse(record(meta.team).id);
  return { kind: 'CONVERSATION_CONTROL', remoteConversationId: conversation.id, remoteUpdatedAt: conversation.updated_at ?? null,
    status: conversation.status, assignee: assigned, teamId, mayForwardReply: false,
    interruptsBot: conversation.status !== 'pending' || (assigned.kind !== 'NONE'&&assigned.kind!=='BROKER_BOT') };
}
