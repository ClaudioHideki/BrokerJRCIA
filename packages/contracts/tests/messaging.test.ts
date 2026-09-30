import { describe, expect, it } from 'vitest';
import {
  ConfigureBotRequestSchema,
  ConversationModeRequestSchema,
  SendTemplateRequestSchema,
  TemplateViewSchema,
} from '../src/messaging/schemas.js';

describe('contratos públicos de mensageria', () => {
  const request = { conversationId: '73dcf81e-0544-4e5c-9830-d9f646b7152d', name: 'boas_vindas', language: 'pt_BR', variables: ['Cliente'] };
  it('aceita template e variáveis sem identificadores de provider', () => {
    expect(SendTemplateRequestSchema.parse(request)).toEqual(request);
  });
  it.each(['organizationId', 'accessToken', 'phoneNumberId', 'credentialReference'])('rejeita campo privilegiado %s', (key) => {
    expect(SendTemplateRequestSchema.safeParse({ ...request, [key]: 'forged' }).success).toBe(false);
  });
  it('limita parâmetros e rejeita nomes de template inválidos', () => {
    expect(SendTemplateRequestSchema.safeParse({ ...request, name: '../messages' }).success).toBe(false);
    expect(SendTemplateRequestSchema.safeParse({ ...request, variables: Array(101).fill('x') }).success).toBe(false);
  });
  it('configura bot por referência aprovada no servidor sem aceitar URL ou segredo', () => {
    const input = { expectedOwnerRevision: 3, publicId: 'meu-bot', originReference: 'typebot-cloud' };
    expect(ConfigureBotRequestSchema.parse(input)).toEqual(input);
    expect(ConfigureBotRequestSchema.safeParse({ expectedOwnerRevision: 3, publicId: 'meu-bot', originReference: 'cloud', url: 'http://127.0.0.1' }).success).toBe(false);
  });
  it.each([undefined, null, -1, 1.5, '1'])('rejects an absent or invalid owner revision: %s', (expectedOwnerRevision) => {
    expect(ConfigureBotRequestSchema.safeParse({
      expectedOwnerRevision, publicId: 'meu-bot', originReference: 'typebot-cloud',
    }).success).toBe(false);
  });
  it('accepts the initial owner revision without guessing a later one', () => {
    const input = { expectedOwnerRevision: 0, publicId: 'meu-bot', originReference: 'typebot-cloud' };
    expect(ConfigureBotRequestSchema.parse(input)).toEqual(input);
  });
  it.each(['accessToken', 'credentialReference', 'organizationId'])('rejects privileged bot configuration field %s with a valid revision', (key) => {
    expect(ConfigureBotRequestSchema.safeParse({
      expectedOwnerRevision: 3, publicId: 'meu-bot', originReference: 'typebot-cloud', [key]: 'forged',
    }).success).toBe(false);
  });
  it('aceita apenas modos explícitos de atendimento', () => {
    expect(ConversationModeRequestSchema.parse({ mode: 'HUMAN' })).toEqual({ mode: 'HUMAN' });
    expect(ConversationModeRequestSchema.safeParse({ mode: 'ADMIN' }).success).toBe(false);
  });
  it('publica somente a contagem de variáveis BODY suportadas', () => {
    const template = {
      id: 'template', name: 'boas_vindas', language: 'pt_BR', status: 'APPROVED',
      category: 'UTILITY', bodyVariableCount: 2,
    };
    expect(TemplateViewSchema.parse(template)).toEqual(template);
    expect(TemplateViewSchema.parse({ ...template, bodyVariableCount: null })).toEqual({
      ...template,
      bodyVariableCount: null,
    });
    expect(TemplateViewSchema.safeParse({ ...template, bodyVariableCount: -1 }).success).toBe(false);
    expect(TemplateViewSchema.safeParse({ ...template, bodyVariableCount: 1.5 }).success).toBe(false);
    expect(TemplateViewSchema.safeParse({ ...template, bodyVariableCount: 101 }).success).toBe(false);
  });
});
