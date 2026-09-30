import { describe, expect, it } from 'vitest';
import { classifyChatwootAttendanceEvent } from '../../src/modules/integrations/chatwoot-attendance-events.js';

const scope = { organizationId: 'tenant-a', integrationId: 'integration-a', accountId: 1, inboxId: 11 };
const conversation = { id: 7, account: { id: 1 }, inbox_id: 11, status: 'pending', updated_at: 1750000000.125,
  meta: { assignee: null, assignee_type: null, team: null } };
const message = { event: 'message_created', id: 101, account: { id: 1 }, inbox: { id: 11 }, conversation,
  message_type: 'outgoing', private: false, sender: { id: 9, type: 'user' }, content: 'Private customer text' };

describe('authenticated Chatwoot attendance event classification', () => {
  it('identifies a public human reply without retaining customer content or sender email', () => {
    const result = classifyChatwootAttendanceEvent({ ...message, sender: { ...message.sender, email: 'private@example.test' } }, scope);
    expect(result).toEqual({ kind: 'HUMAN_PUBLIC', remoteConversationId: 7, remoteMessageId: 101, senderId: 9, mayForwardReply: true, interruptsBot: true });
    expect(JSON.stringify(result)).not.toMatch(/Private customer|private@example/);
  });
  it('a private note may signal human activity but must never be forwarded', () => {
    expect(classifyChatwootAttendanceEvent({ ...message, private: true }, scope)).toMatchObject({
      kind: 'HUMAN_PRIVATE', mayForwardReply: false, interruptsBot: true,
    });
  });
  it('distinguishes external AgentBot messages from a human takeover', () => {
    expect(classifyChatwootAttendanceEvent({ ...message, sender: { id: 5, type: 'agent_bot' } }, scope))
      .toMatchObject({ kind: 'EXTERNAL_BOT', senderId: 5, interruptsBot: true, mayForwardReply: true });
  });
  it.each([{ sender: null }, { sender: undefined }, { sender: { id: 9 } }, { sender: { id: 9, type: 'captain_assistant' } }])(
    'does not infer a human when the sender type is missing or unsupported: %j', patch => {
      expect(classifyChatwootAttendanceEvent({ ...message, ...patch }, scope))
        .toMatchObject({ kind: 'UNVERIFIED_REPLY', mayForwardReply: false, interruptsBot: true });
    });
  it.each([{ content_attributes: { automation_rule_id: 12 } }, { additional_attributes: { campaign_id: 12 } }])(
    'does not treat user-authored system automation (%j) as a human', attributes => {
      expect(classifyChatwootAttendanceEvent({ ...message, ...attributes }, scope))
        .toMatchObject({ kind: 'AUTOMATED_REPLY', mayForwardReply: true, interruptsBot: true });
    });
  it('does not trust a claimed Broker message ID to hide another sender', () => {
    expect(classifyChatwootAttendanceEvent({ ...message, content_attributes: { jrc_broker_message_id: 'forged' } }, scope))
      .toMatchObject({ kind: 'HUMAN_PUBLIC', interruptsBot: true });
  });
  it('recognizes an echo only from a persisted mapping matching every dimension', () => {
    const evidence = { ...scope, remoteConversationId: 7, remoteMessageId: 101 };
    expect(classifyChatwootAttendanceEvent(message, scope, evidence)).toMatchObject({
      kind: 'BROKER_ECHO', mayForwardReply: false, interruptsBot: false,
    });
    for (const patch of [{ organizationId: 'tenant-b' }, { integrationId: 'integration-b' }, { accountId: 2 },
      { inboxId: 12 }, { remoteConversationId: 8 }, { remoteMessageId: 102 }]) {
      expect(classifyChatwootAttendanceEvent(message, scope, { ...evidence, ...patch })).toMatchObject({ kind: 'HUMAN_PUBLIC' });
    }
  });
  it.each(['incoming', 0])('contact input (%s) is not a reply and does not take over', message_type => {
    expect(classifyChatwootAttendanceEvent({ ...message, message_type, sender: { id: 4, type: 'contact' } }, scope))
      .toMatchObject({ kind: 'CONTACT_MESSAGE', interruptsBot: false, mayForwardReply: false });
  });
  it.each(['activity', 2, 'template', 3])('does not forward system messages (%s)', message_type => {
    expect(classifyChatwootAttendanceEvent({ ...message, message_type }, scope))
      .toMatchObject({ kind: 'SYSTEM_MESSAGE', interruptsBot: false, mayForwardReply: false });
  });
  it.each([
    { account: { id: 2 } }, { inbox: { id: 12 } },
    { conversation: { ...conversation, account: { id: 2 } } }, { conversation: { ...conversation, inbox_id: 12 } },
  ])('rejects a message with mixed account/inbox scope: %j', patch => {
    expect(() => classifyChatwootAttendanceEvent({ ...message, ...patch }, scope)).toThrow('CHATWOOT_BINDING_MISMATCH');
  });
  it('uses top-level conversation webhook data rather than the last message embedded in it', () => {
    const result = classifyChatwootAttendanceEvent({ ...conversation, event: 'conversation_updated', messages: [message],
      meta: { assignee: { id: 9, type: 'user' }, assignee_type: 'User', team: { id: 4 } } }, scope);
    expect(result).toMatchObject({ kind: 'CONVERSATION_CONTROL', remoteConversationId: 7, remoteUpdatedAt: 1750000000.125,
      status: 'pending', assignee: { kind: 'HUMAN', id: 9 }, teamId: 4, interruptsBot: true, mayForwardReply: false });
    expect(result).not.toHaveProperty('remoteMessageId');
  });
  it('distinguishes a bot assigned to the conversation even if the inbox has none', () => {
    expect(classifyChatwootAttendanceEvent({ ...conversation, event: 'conversation_updated',
      meta: { assignee: { id: 5, type: 'agent_bot' }, assignee_type: 'AgentBot', team: null } }, scope))
      .toMatchObject({ assignee: { kind: 'EXTERNAL_BOT', id: 5 }, interruptsBot: true });
  });
  it('rejects contradictory assignee kinds instead of treating them as unassigned', () => {
    expect(() => classifyChatwootAttendanceEvent({ ...conversation, event: 'conversation_updated',
      meta: { assignee: { id: 5, type: 'agent_bot' }, assignee_type: 'User', team: null } }, scope))
      .toThrow('CHATWOOT_CONTROL_INVALID');
  });
  it.each(['open', 'resolved', 'snoozed'])('status %s stops further bot effects', status => {
    expect(classifyChatwootAttendanceEvent({ ...conversation, event: 'conversation_status_changed', status }, scope))
      .toMatchObject({ kind: 'CONVERSATION_CONTROL', status, interruptsBot: true, mayForwardReply: false });
  });
  it('a pending unassigned event never authorizes resuming a bot', () => {
    const result = classifyChatwootAttendanceEvent({ ...conversation, event: 'conversation_status_changed' }, scope);
    expect(result).toMatchObject({ kind: 'CONVERSATION_CONTROL', assignee: { kind: 'NONE' }, interruptsBot: false });
    expect(result).not.toHaveProperty('resumeBot');
  });
  it('missing metadata is unknown rather than proof of an unassigned conversation', () => {
    expect(classifyChatwootAttendanceEvent({ ...conversation, meta: undefined, event: 'conversation_created' }, scope))
      .toMatchObject({ assignee: { kind: 'UNKNOWN' }, interruptsBot: true });
  });
  it('ignores unsupported event names and rejects malformed supported events', () => {
    expect(classifyChatwootAttendanceEvent({ event: 'contact_updated' }, scope)).toBeNull();
    expect(() => classifyChatwootAttendanceEvent({ ...message, id: Number.MAX_SAFE_INTEGER + 1 }, scope)).toThrow();
    expect(() => classifyChatwootAttendanceEvent({ ...conversation, event: 'conversation_updated', status: 'typo' }, scope)).toThrow();
  });
});
