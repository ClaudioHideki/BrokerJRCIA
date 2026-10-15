import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { automationNodePorts, getNodeDefinition } from '../src/index.js';
import {
  ActionCatalogPageSchema, ActionResourceSchema, ActionSimulationResponseSchema, AutomationMediaAssetSchema,
  AutomationResourceChannelsSchema, ConversationEffectConfigSchema, ConversationEffectConfigV1Schema,
  ConversationEffectWaitSchema, MediaEffectConfigSchema, MediaEffectConfigV1Schema,
  compatibleConversationEffectSchema, conversationEffectPorts, validateConversationAttribute,
} from '../src/automation-conversation-effects.js';

const channelId = '12345678-1234-4234-8234-123456789abc';
const resourceId = '11111111-2222-4333-8444-555555555555';
const waitId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const scope = { organizationId: channelId, rootAutomationId: resourceId, channelId: waitId };
const base = { conversationEffectVersion: 2, channelId, target: 'action.result', timeoutMs: 15000 };
const note = { ...base, operation: 'note', text: 'Nota privada' };
const attribute = { ...base, operation: 'attribute', resourceId, resourceRevision: 'a'.repeat(64) };
const media = { mediaEffectVersion: 2, channelId, mediaId: resourceId, mediaRevision: 1,
  target: 'media.result', caption: '', timeoutMs: 15000 };
const definition = { valueType: 'string' as const, maxLength: 32, allowedValues: [] };

describe('conversation effects version 2', () => {
  it('validates v2 through the shared node definitions used by the editor and publisher', () => {
    expect(getNodeDefinition('note', 1)!.schema.safeParse(note).success).toBe(true);
    expect(getNodeDefinition('media', 1)!.schema.safeParse(media).success).toBe(true);
    expect(getNodeDefinition('tag', 1)!.schema.safeParse({ ...base, operation: 'note', text: 'wrong type' }).success).toBe(false);
  });
  it('uses terminal resolve ports and the same three outcomes in the actual node catalog', () => {
    const node = (type: string, data: Record<string, unknown>) => ({ id: 'effect', type, label: type, position: { x: 0, y: 0 }, data });
    expect(automationNodePorts(node('resolve', { ...base, operation: 'resolve', status: 'RESOLVED' }))).toEqual([]);
    expect(automationNodePorts(node('note', note))).toEqual(['success', 'error', 'timeout']);
    expect(automationNodePorts(node('media', media))).toEqual(['success', 'error', 'timeout']);
    expect(automationNodePorts(node('note', { ...note, conversationEffectVersion: 1 }))).toEqual(['success', 'error', 'timeout', 'unknown']);
  });
  it('creates bounded private notes, named resources and terminal resolve configurations', () => {
    for (const value of [note, { ...base, operation: 'resolve', status: 'RESOLVED' },
      { ...base, operation: 'tag', resourceId, resourceRevision: 'a'.repeat(64) }]) {
      expect(ConversationEffectConfigSchema.parse(value)).toEqual(value);
    }
    expect(ConversationEffectConfigSchema.safeParse({ ...note, private: false }).success).toBe(false);
    expect(ConversationEffectConfigSchema.safeParse({ ...base, operation: 'resolve', status: 'OPEN' }).success).toBe(false);
  });
  it.each([false, 0, -1.5, 'texto'])('preserves a typed literal %s instead of coercing it to text', value => {
    const input = { ...attribute, valueSource: { kind: 'LITERAL', value } };
    expect(ConversationEffectConfigSchema.parse(input)).toEqual(input);
  });
  it('accepts a safe variable reference and refuses objects, unsafe references and missing resource pins', () => {
    expect(ConversationEffectConfigSchema.safeParse({ ...attribute, valueSource: { kind: 'VARIABLE', variable: 'customer.active' } }).success).toBe(true);
    for (const candidate of [
      { ...attribute, valueSource: { kind: 'LITERAL', value: {} } },
      { ...attribute, valueSource: { kind: 'VARIABLE', variable: '__proto__.polluted' } },
      { ...attribute, resourceRevision: undefined, valueSource: { kind: 'LITERAL', value: 0 } },
      { ...note, text: '😀'.repeat(1025) }, { ...note, text: '   ' },
      { ...note, conversationEffectVersion: 3 }, { ...note, timeoutMs: 30001 },
    ]) expect(ConversationEffectConfigSchema.safeParse(candidate).success).toBe(false);
  });
  it('uses a private media identity and version instead of a public URL or inline payload', () => {
    expect(MediaEffectConfigSchema.parse(media)).toEqual(media);
    for (const invalid of [{ ...media, url: 'https://example.test/photo.png' }, { ...media, base64: 'AAAA' },
      { ...media, mediaRevision: 0 }, { ...media, caption: '😀'.repeat(257) }, { ...media, mediaEffectVersion: 3 }]) {
      expect(MediaEffectConfigSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it('keeps v1 schemas and ports readable without upgrading their semantics to version 2', () => {
    const oldNote = { ...note, conversationEffectVersion: 1 }, oldMedia = { ...media, mediaEffectVersion: 1 };
    expect(ConversationEffectConfigV1Schema.parse(oldNote)).toEqual(oldNote);
    expect(MediaEffectConfigV1Schema.parse(oldMedia)).toEqual(oldMedia);
    expect(ConversationEffectConfigSchema.safeParse(oldNote).success).toBe(false);
    expect(MediaEffectConfigSchema.safeParse(oldMedia).success).toBe(false);
    expect(compatibleConversationEffectSchema('note', z.object({ text: z.string() })).parse(oldNote)).toEqual(oldNote);
    expect(compatibleConversationEffectSchema('note', z.object({ text: z.string() })).safeParse({ ...note, operation: 'resolve' }).success).toBe(false);
    expect(conversationEffectPorts(oldNote)).toEqual(['success', 'error', 'timeout', 'unknown']);
    expect(conversationEffectPorts({})).toEqual(['success', 'error']);
  });
  it('never presents UNKNOWN as an executable v2 edge and makes resolve terminal', () => {
    expect(conversationEffectPorts(note)).toEqual(['success', 'error', 'timeout']);
    expect(conversationEffectPorts(media)).toEqual(['success', 'error', 'timeout']);
    expect(conversationEffectPorts({ ...base, operation: 'resolve' })).toEqual([]);
    expect(conversationEffectPorts({ conversationEffectVersion: 2 }, 'resolve')).toEqual([]);
  });
  it('requires the exact wait identity in simulation events and action waits', () => {
    const wait = { nodeId: 'note-1', operation: 'note', waitId };
    const event = { type: 'ACTION_RESPONSE', nodeId: 'note-1', waitId, outcome: 'unknown' };
    expect(ConversationEffectWaitSchema.parse(wait)).toEqual(wait);
    expect(ActionSimulationResponseSchema.parse(event)).toEqual(event);
    expect(ConversationEffectWaitSchema.safeParse({ ...wait, waitId: undefined }).success).toBe(false);
    expect(ActionSimulationResponseSchema.safeParse({ ...event, waitId: undefined }).success).toBe(false);
  });
});

describe('typed conversation values and scoped catalogs', () => {
  it.each([
    ['number', 0], ['boolean', false], ['string', 'texto'], ['date', '2024-02-29'], ['url', 'https://example.test/path'],
  ] as const)('validates %s without changing the supplied value', (valueType, value) => {
    expect(validateConversationAttribute({ ...definition, valueType, maxLength: 64 }, value)).toBe(value);
  });
  it('refuses invalid typed data, overlong UTF-8, wrong enum options and impossible dates', () => {
    for (const [valueType, value] of [['number', '0'], ['boolean', 'false'], ['date', '2023-02-29'],
      ['url', 'javascript:alert(1)'], ['url', 'https://user:password@example.test'], ['string', '😀'.repeat(9)]] as const) {
      expect(() => validateConversationAttribute({ ...definition, valueType }, value)).toThrow('AUTOMATION_ATTRIBUTE_VALUE_INVALID');
    }
    expect(() => validateConversationAttribute({ ...definition, valueType: 'enum', allowedValues: ['A', 'B'] }, 'C')).toThrow();
    expect(validateConversationAttribute({ ...definition, valueType: 'enum', allowedValues: ['A', 'B'] }, 'B')).toBe('B');
  });
  it('keeps label and attribute resources disjoint and scopes private assets', () => {
    const label = { id: resourceId, name: 'Cliente', kind: 'LABEL', revision: 'b'.repeat(64), definition: null };
    expect(ActionResourceSchema.parse(label)).toEqual(label);
    expect(ActionResourceSchema.safeParse({ ...label, kind: 'ATTRIBUTE' }).success).toBe(false);
    const asset = { schemaVersion: 1, scope, id: channelId, revision: 1, status: 'READY', name: 'teste.png', kind: 'image',
      mimeType: 'image/png', byteSize: 42 };
    expect(AutomationMediaAssetSchema.parse(asset)).toEqual(asset);
    expect(AutomationMediaAssetSchema.safeParse({ ...asset, publicUrl: 'https://example.test/private' }).success).toBe(false);
    expect(AutomationMediaAssetSchema.safeParse({ ...asset, byteSize: 16777217 }).success).toBe(false);
  });
  it('bounds and scopes resource channels and rejects duplicated IDs in one page', () => {
    const page = { schemaVersion: 1, scope: { organizationId: channelId, rootAutomationId: resourceId },
      data: [{ id: waitId, name: 'Atendimento' }], nextCursor: null };
    expect(AutomationResourceChannelsSchema.parse(page)).toEqual(page);
    expect(AutomationResourceChannelsSchema.safeParse({ ...page, data: [...page.data, ...page.data] }).success).toBe(false);
    expect(AutomationResourceChannelsSchema.safeParse({ ...page, data: Array.from({ length: 201 }, () => page.data[0]) }).success).toBe(false);
  });
  it('does not represent an unverified capability as supported or allow unbounded catalogs', () => {
    const supported = { state: 'SUPPORTED', reason: null };
    const page = { schemaVersion: 1, scope, profile: 'CENTRAL', capabilities: {
      tag: supported, attribute: supported, note: supported, resolve: supported, media: supported,
    }, data: [], nextCursor: null };
    expect(ActionCatalogPageSchema.parse(page)).toEqual(page);
    expect(ActionCatalogPageSchema.safeParse({ ...page, capabilities: { ...page.capabilities,
      note: { state: 'UNVERIFIED', reason: null } } }).success).toBe(false);
  });
});
