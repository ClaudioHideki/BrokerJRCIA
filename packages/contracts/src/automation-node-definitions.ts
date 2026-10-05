import { z } from 'zod';
import { CompatibleAutomationHandoffConfigSchema } from './automation-handoff-v1.js';
import { menuOptions, type FlowNode } from './flows.js';

export const NodeDiagnosticSchema = z.object({
  nodeId: z.string().nullable(), field: z.string(), code: z.string(), message: z.string(),
});
export type NodeDiagnostic = z.infer<typeof NodeDiagnosticSchema>;
export interface AutomationNodeDefinition {
  type: string; version: number; label: string; category: string; description: string;
  schema: z.ZodType; ports(node: FlowNode): string[]; capabilitiesRequired: readonly string[];
  availability: 'AVAILABLE' | 'UNAVAILABLE'; unavailableReason: string | null;
  runtimeSupported: boolean;
}

const safeKey = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.-]{0,99}$/)
  .refine(value => !value.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part)), 'Nome de variável inválido.');
const value = (input: unknown) => typeof input === 'string' ? input : typeof input === 'number' || typeof input === 'boolean' ? String(input) : '';
const text = z.unknown().refine(input => Boolean(value(input).trim()) && value(input).length <= 4096, 'Informe uma mensagem de até 4096 caracteres.');
const credentialId = z.string().regex(/^[0-9a-f-]{36}$/i, 'Selecione uma credencial do cofre.');
const config = (shape: z.ZodRawShape = {}) => z.object(shape).passthrough();
const next = () => ['next'];
const terminal = () => [];
const io = () => ['success', 'error'];
const define = (type: string, label: string, category: string, schema: z.ZodType, ports: AutomationNodeDefinition['ports'] = next,
  pending: string | null = null, runtimeSupported = true): AutomationNodeDefinition => ({
  type, version: 1, label, category, description: label, schema, ports, runtimeSupported,
  capabilitiesRequired: pending ? [pending] : [], availability: pending ? 'UNAVAILABLE' : 'AVAILABLE',
  unavailableReason: pending ? `A criação deste bloco aguarda ${pending}; grafos existentes são preservados.` : null,
});

// Version 1 accepts historical configurations without changing their execution semantics.
// Availability controls the creation palette only; it must never gate a published executor.
export const AUTOMATION_NODE_DEFINITIONS: readonly AutomationNodeDefinition[] = [
  define('start', 'Mensagem recebida', 'TRIGGERS', config()),
  define('message', 'Enviar texto', 'CONVERSATION', config({ text })),
  define('input', 'Capturar resposta', 'INPUTS', config({ variable: safeKey,
    text: z.unknown().refine(input => value(input).length <= 4096, 'Pergunta muito longa.').optional(),
    timeout: z.unknown().refine(input => !(Number(input ?? 0) > 0), 'Timeout importado ainda não suportado.').optional() })),
  define('menu', 'Menu textual', 'INPUTS', config({ text, options: z.unknown().refine(options => {
    const parsed = menuOptions({ id: '', label: '', position: { x: 0, y: 0 }, type: 'menu', data: { options } });
    return Array.isArray(options) && parsed.length >= 2 && parsed.length <= 10 && parsed.length === options.length && new Set(parsed.map(option => option.value)).size === parsed.length;
  }, 'Configure de 2 a 10 opções numeradas e únicas.') }), node => menuOptions(node).map(option => `option-${option.value}`)),
  define('condition', 'Condição', 'LOGIC', config({ field: safeKey, operator: z.enum(['equals', 'not_equals', 'contains', 'starts_with', 'present']) }), () => ['yes', 'no']),
  define('variable', 'Definir variável', 'DATA', config({ variable: safeKey })),
  ...['data-set', 'data-rename', 'data-pick', 'data-merge', 'data-map', 'data-filter', 'json-parse', 'json-stringify', 'expression'].map(type =>
    define(type, ({ 'data-set': 'Definir dado', 'data-rename': 'Renomear dado', 'data-pick': 'Selecionar campos', 'data-merge': 'Mesclar objetos', 'data-map': 'Mapear lista', 'data-filter': 'Filtrar lista', 'json-parse': 'Ler JSON', 'json-stringify': 'Gerar JSON', expression: 'Expressão segura' } as Record<string, string>)[type]!, 'DATA',
      config({ target: z.string(), ...(type === 'expression' ? { expression: z.string() } : {}) }), next, 'R6 e U3b (dados e formulário completo)')),
  define('http', 'HTTP seguro', 'INTEGRATIONS', config({ target: safeKey, credentialId, url: z.string().startsWith('https://') }), () => ['success', 'client_error', 'server_error', 'timeout', 'unknown'], 'R7 e U3b/U5 (consulta delimitada e simulação)'),
  define('sql', 'Consulta SQL', 'INTEGRATIONS', config({ target: safeKey, credentialId, query: z.string() }), io, 'capacidade fora do escopo de criação Broker'),
  define('code', 'JavaScript isolado', 'LOGIC', config({ target: safeKey, code: z.string() }), io, 'capacidade fora do escopo de criação Broker'),
  ...['ai-generate', 'ai-classify', 'ai-extract', 'ai-summarize', 'ai-agent'].map(type => define(type,
    ({ 'ai-generate': 'IA: gerar', 'ai-classify': 'IA: classificar', 'ai-extract': 'IA: extrair', 'ai-summarize': 'IA: resumir', 'ai-agent': 'Agente de IA' } as Record<string, string>)[type]!, 'AI',
    config({ target: safeKey, credentialId }), io, type === 'ai-agent' ? 'agente genérico fora do escopo de criação Broker' : 'R7 e U3b/U5 (IA delimitada e simulação)')),
  define('delay', 'Aguardar', 'LOGIC', config({ seconds: z.coerce.number().int().min(1).max(604800) }), next, 'R4/U5 (silêncio e simulação de espera)'),
  define('subflow', 'Subflow versionado', 'LOGIC', config({ automationId: credentialId, version: z.coerce.number().int().positive(), timeoutMs: z.preprocess(input => input ?? 10000, z.coerce.number().int().min(100).max(30000)).optional() }), next, 'R6/U3b/U5 (seletor e simulação de dependências)'),
  define('handoff', 'Atendimento humano', 'HUMAN', CompatibleAutomationHandoffConfigSchema, terminal),
  define('end', 'Encerrar', 'LOGIC', config(), terminal),
  define('media', 'Enviar mídia', 'CONVERSATION', config({ url: z.url(), mediaType: z.enum(['image', 'audio', 'video', 'document']) }), io, 'R6/U3b (mídia por capacidade)', false),
  define('schedule', 'Horário', 'LOGIC', config({ timezone: z.string().min(1), schedule: z.array(z.unknown()).min(1) }), () => ['open', 'closed'], 'R6/U3b (horários e fuso)', false),
  define('tag', 'Adicionar etiqueta', 'HUMAN', config({ tag: z.string().min(1) }), io, 'R3/R6/U3b (catálogo e ação de etiqueta)', false),
  define('attribute', 'Definir atributo', 'HUMAN', config({ name: z.string().min(1), value: z.unknown().refine(input => input !== undefined, 'Informe um valor.') }), io, 'R3/R6/U3b (atributos autorizados)', false),
  define('note', 'Nota interna', 'HUMAN', config({ text }), io, 'R6/U3b (nota na central)', false),
  define('resolve', 'Resolver atendimento', 'HUMAN', config(), io, 'R5/R6/U3b (resolução na central)', false),
];
export function getNodeDefinition(type: string, version: number): AutomationNodeDefinition | null {
  return AUTOMATION_NODE_DEFINITIONS.find(definition => definition.type === type && definition.version === version) ?? null;
}
export function nodeDiagnosticsToStrings(diagnostics: readonly NodeDiagnostic[]): string[] { return diagnostics.map(item => item.message); }
export function legacyStringsToNodeDiagnostics(messages: readonly string[]): NodeDiagnostic[] {
  // Old messages cannot identify a node safely, especially when labels are duplicated.
  return messages.map(message => ({ nodeId: null, field: '', code: 'LEGACY_VALIDATION', message }));
}
