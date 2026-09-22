import { z } from 'zod';

import { FlowGraphSchema, type FlowGraph } from './flows.js';
import { flowPorts, type FlowNode } from './flows.js';

export const AUTOMATION_CONTRACT_VERSION = 1 as const;
export const AUTOMATION_ORIGIN = 'jrc-automation-v2' as const;
export const AUTOMATION_NODE_CATALOG_V1 = [
  { type:'start', category:'TRIGGERS', label:'Mensagem recebida', description:'Inicia quando o canal recebe uma mensagem.' },
  { type:'message', category:'CONVERSATION', label:'Enviar texto', description:'Envia texto com variáveis da conversa.' },
  { type:'input', category:'INPUTS', label:'Capturar resposta', description:'Faz uma pergunta e espera a próxima mensagem.' },
  { type:'menu', category:'INPUTS', label:'Menu textual', description:'Exibe opções numeradas compatíveis com todos os canais.' },
  { type:'condition', category:'LOGIC', label:'Condição', description:'Escolhe o caminho Sim ou Não.' },
  { type:'variable', category:'DATA', label:'Definir variável', description:'Guarda um valor no estado da execução.' },
  { type:'data-set', category:'DATA', label:'Definir dado', description:'Define um valor JSON sem executar código.' },
  { type:'data-rename', category:'DATA', label:'Renomear dado', description:'Move um valor entre variáveis.' },
  { type:'data-pick', category:'DATA', label:'Selecionar campos', description:'Seleciona campos permitidos de um objeto.' },
  { type:'data-merge', category:'DATA', label:'Mesclar objetos', description:'Mescla objetos JSON em ordem declarada.' },
  { type:'data-map', category:'DATA', label:'Mapear lista', description:'Projeta um campo seguro de cada item.' },
  { type:'data-filter', category:'DATA', label:'Filtrar lista', description:'Filtra itens por comparação declarativa.' },
  { type:'json-parse', category:'DATA', label:'Ler JSON', description:'Converte texto JSON em dado estruturado.' },
  { type:'json-stringify', category:'DATA', label:'Gerar JSON', description:'Converte dado estruturado em texto JSON.' },
  { type:'expression', category:'LOGIC', label:'Expressão segura', description:'Avalia literais, referências e funções permitidas.' },
  { type:'http', category:'INTEGRATIONS', label:'HTTP seguro', description:'Chama uma API HTTPS com credencial do cofre.' },
  { type:'sql', category:'INTEGRATIONS', label:'Consulta SQL', description:'Executa consulta parametrizada e somente leitura.' },
  { type:'code', category:'LOGIC', label:'JavaScript isolado', description:'Executa transformação JavaScript sem rede, arquivos ou ambiente.' },
  { type:'ai-generate', category:'AI', label:'IA: gerar', description:'Gera conteúdo com provedor configurado no cofre.' },
  { type:'ai-classify', category:'AI', label:'IA: classificar', description:'Classifica conteúdo com saída controlada.' },
  { type:'ai-extract', category:'AI', label:'IA: extrair', description:'Extrai JSON conforme o schema informado.' },
  { type:'ai-summarize', category:'AI', label:'IA: resumir', description:'Resume conteúdo sem persistir o texto no log.' },
  { type:'ai-agent', category:'AI', label:'Agente de IA', description:'Executa apenas ferramentas explicitamente autorizadas.' },
  { type:'delay', category:'LOGIC', label:'Aguardar', description:'Persiste um atraso de 1 segundo a 7 dias.' },
  { type:'subflow', category:'LOGIC', label:'Subflow versionado', description:'Executa uma versão imutável de outra automação.' },
  { type:'handoff', category:'HUMAN', label:'Atendimento humano', description:'Pausa o bot e entrega a conversa ao atendimento.' },
  { type:'end', category:'LOGIC', label:'Encerrar', description:'Conclui a execução.' },
] as const;
export function automationNodePorts(node:FlowNode):string[]{if(node.type==='http')return ['success','client_error','server_error','timeout','unknown'];if(['sql','code','ai-generate','ai-classify','ai-extract','ai-summarize','ai-agent'].includes(node.type))return ['success','error'];return ['delay','subflow','data-set','data-rename','data-pick','data-merge','data-map','data-filter','json-parse','json-stringify','expression'].includes(node.type)?['next']:flowPorts(node);}

const forbiddenSecretKey = /(?:access.?token|token|api.?key|secret|password|authorization|private.?key|connection.?string|credential)$/iu;

function findSecretKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSecretKey(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenSecretKey.test(key)) return key;
    const found = findSecretKey(child);
    if (found) return found;
  }
  return null;
}

export const AutomationGraphV1Schema = FlowGraphSchema.superRefine((graph, context) => {
  const key = findSecretKey(graph);
  if (key) context.addIssue({ code: 'custom', message: `Secret field is not allowed in automation DTO: ${key}` });
});

export const AutomationLifecycleStatusV1Schema = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']);

export const AutomationDefinitionV1Schema = z.strictObject({
  schemaVersion: z.literal(AUTOMATION_CONTRACT_VERSION),
  id: z.uuid(),
  organizationId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  lifecycleStatus: AutomationLifecycleStatusV1Schema,
  draft: z.strictObject({
    revision: z.number().int().positive(),
    graph: AutomationGraphV1Schema,
  }),
  activeVersion: z.number().int().positive().nullable(),
  updatedAt: z.iso.datetime(),
}).refine(
  ({ lifecycleStatus, activeVersion }) => lifecycleStatus !== 'PUBLISHED' || activeVersion !== null,
  { message: 'Published automation requires an active version.', path: ['activeVersion'] },
);

export const AutomationPublishedVersionV1Schema = z.strictObject({
  schemaVersion: z.literal(AUTOMATION_CONTRACT_VERSION),
  automationId: z.uuid(),
  organizationId: z.uuid(),
  version: z.number().int().positive(),
  graph: AutomationGraphV1Schema,
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  publishedAt: z.iso.datetime(),
});

export const AutomationBindingV1Schema = z.strictObject({
  schemaVersion: z.literal(AUTOMATION_CONTRACT_VERSION),
  id: z.uuid(),
  organizationId: z.uuid(),
  automationId: z.uuid(),
  version: z.number().int().positive(),
  channelId: z.uuid(),
  humanDestinationId: z.uuid().nullable(),
  status: z.enum(['ACTIVE', 'PAUSED', 'DISABLED']),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const AutomationExecutionSummaryV1Schema = z.strictObject({
  schemaVersion: z.literal(AUTOMATION_CONTRACT_VERSION),
  id: z.uuid(),
  organizationId: z.uuid(),
  automationId: z.uuid(),
  version: z.number().int().positive(),
  bindingId: z.uuid(),
  channelId: z.uuid(),
  status: z.enum(['QUEUED', 'RUNNING', 'WAITING', 'HANDOFF', 'COMPLETED', 'FAILED', 'CANCELED', 'UNKNOWN']),
  currentNodeId: z.string().min(1).max(100).nullable(),
  correlationId: z.uuid(),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

export interface LegacyFlowRecordV1 {
  id: string;
  name: string;
  graph: FlowGraph;
  revision: number;
  publishedVersion: number | null;
  updatedAt: string;
}

export function adaptLegacyFlowRecordToAutomationV1(
  flow: LegacyFlowRecordV1,
  organizationId: string,
): AutomationDefinitionV1 {
  return AutomationDefinitionV1Schema.parse({
    schemaVersion: AUTOMATION_CONTRACT_VERSION,
    id: flow.id,
    organizationId,
    name: flow.name,
    lifecycleStatus: flow.publishedVersion === null ? 'DRAFT' : 'PUBLISHED',
    draft: { revision: flow.revision, graph: flow.graph },
    activeVersion: flow.publishedVersion,
    updatedAt: flow.updatedAt,
  });
}

export type AutomationGraphV1 = z.infer<typeof AutomationGraphV1Schema>;
export type AutomationDefinitionV1 = z.infer<typeof AutomationDefinitionV1Schema>;
export type AutomationPublishedVersionV1 = z.infer<typeof AutomationPublishedVersionV1Schema>;
export type AutomationBindingV1 = z.infer<typeof AutomationBindingV1Schema>;
export type AutomationExecutionSummaryV1 = z.infer<typeof AutomationExecutionSummaryV1Schema>;
