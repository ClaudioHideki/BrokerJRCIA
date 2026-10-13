import {describe,it,expect} from 'vitest';
import {groupScopeUnchanged,groupMessageBelongsToScope,groupReplyMayDispatch} from '../../src/modules/whatsapp-groups/central-group-store.js';
const scope={organizationId:'11111111-1111-4111-8111-111111111111',channelId:'22222222-2222-4222-8222-222222222222',integrationId:'33333333-3333-4333-8333-333333333333',destinationRevision:1,instanceId:'44444444-4444-4444-8444-444444444444',identityRevision:1,identityFingerprint:'a'.repeat(64),groupJid:'120363123@g.us'};
describe('central group physical scope',()=>{
 it('accepts only the same tenant, destination and physical epoch',()=>{
  expect(groupScopeUnchanged(scope,{...scope})).toBe(true);
  for(const key of ['organizationId','channelId','integrationId','instanceId'] as const)expect(groupScopeUnchanged(scope,{...scope,[key]:'55555555-5555-4555-8555-555555555555'})).toBe(false);
  expect(groupScopeUnchanged(scope,{...scope,destinationRevision:2})).toBe(false);
  expect(groupScopeUnchanged(scope,{...scope,identityRevision:2})).toBe(false);
  expect(groupScopeUnchanged(scope,{...scope,identityFingerprint:'b'.repeat(64)})).toBe(false);
 });
 it('does not move an old message into the new physical epoch',()=>{
  expect(groupMessageBelongsToScope(scope,'g3:120363123@g.us:1')).toBe(true);
  expect(groupMessageBelongsToScope(scope,'g3:120363123@g.us:2')).toBe(false);
  expect(groupMessageBelongsToScope(scope,'')).toBe(false);
 });
 it('requires an applied public human observation and an exact persisted scope for replies',()=>{
  const reply={scopeKey:'a'.repeat(64),currentScopeKey:'a'.repeat(64),kind:'HUMAN_PUBLIC',disposition:'APPLIED',conversationMode:'HUMAN',attendanceRevision:3,currentAttendanceRevision:3};
  expect(groupReplyMayDispatch(reply)).toBe(true);
  for(const change of [{kind:'PRIVATE_NOTE'},{kind:'AUTOMATED_REPLY'},{disposition:'PENDING'},{conversationMode:'BOT'},{currentAttendanceRevision:4},{currentScopeKey:'b'.repeat(64)}])expect(groupReplyMayDispatch({...reply,...change})).toBe(false);
 });
});
