export type HealthState = 'UP' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';
export interface HealthComponent {
  key: string; label: string; state: HealthState; code: string;
  observedAt: string | null; metric?: number; unit?: string;
}
export interface HealthSnapshot {
  observedAt: string; overall: HealthState; components: HealthComponent[];
  alerts: Array<{ code: string; component: string; state: HealthState }>;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const state = (value: unknown): value is HealthState => typeof value === 'string' && ['UP', 'DEGRADED', 'DOWN', 'UNKNOWN'].includes(value);
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

// Accept additive fields and component keys, but never render an invalid snapshot.
export function parseHealthSnapshot(value: unknown): HealthSnapshot {
  if (!record(value) || !date(value.observedAt) || !state(value.overall) || !Array.isArray(value.components) || !Array.isArray(value.alerts)
    || !value.components.every(item => record(item) && text(item.key) && text(item.label) && state(item.state) && text(item.code)
      && (item.observedAt === null || date(item.observedAt))
      && (item.metric === undefined || typeof item.metric === 'number' && Number.isFinite(item.metric) && (item.metric >= 0 || item.unit === 'seconds'))
      && (item.unit === undefined || typeof item.unit === 'string'))
    || new Set(value.components.map(item => item.key)).size !== value.components.length
    || !value.alerts.every(item => record(item) && text(item.component) && state(item.state) && text(item.code))) {
    throw new Error('Invalid operational health response');
  }
  // Server ages can be negative when DB and API clocks differ. Preserve the raw
  // age for diagnosis rather than rejecting every component or hiding clock skew.
  return value as unknown as HealthSnapshot;
}
export const healthLabels: Record<HealthState, string> = { UP: 'Sinal normal', DEGRADED: 'Atenção', DOWN: 'Indisponível', UNKNOWN: 'Não verificado' };
export const healthGroups = [
  { id: 'infrastructure', title: 'Infraestrutura e processos', description: 'Respostas das dependências e últimos sinais de atividade dos processos.' },
  { id: 'integrations', title: 'Canais e integrações', description: 'Conexões e configurações registradas não comprovam a entrega de mensagens. Confira a evidência de entrada e saída em cada integração.' },
  { id: 'backlog', title: 'Filas e registros acumulados', description: 'Contagens sem recorte de período: podem incluir falhas antigas. Elas não demonstram, isoladamente, uma falha acontecendo agora.' },
] as const;
export function healthGroup(key: string): typeof healthGroups[number]['id'] {
  if (['EVOLUTION', 'META', 'CHATWOOT', 'QR_IDENTITY_PENDING'].includes(key)) return 'integrations';
  if (['QUEUE', 'OUTBOX_AGE', 'FAILED_EXECUTIONS', 'INTEGRATION_FAILURES', 'INTEGRATION_UNCERTAINTY', 'UNKNOWN_EXECUTIONS'].includes(key)) return 'backlog';
  return 'infrastructure';
}
export function healthTitle(key: string, fallback = key): string {
  return ({ EVOLUTION: 'WhatsApp por QR Code', META: 'WhatsApp oficial', CHATWOOT: 'Central de atendimento', SCHEMA: 'Estrutura do banco', QUEUE: 'Itens na fila', OUTBOX_AGE: 'Item mais antigo na outbox', UNKNOWN_EXECUTIONS: 'Execuções com resultado incerto', INTEGRATION_FAILURES: 'Entregas com falha', INTEGRATION_UNCERTAINTY: 'Entregas com resultado incerto', QR_IDENTITY_PENDING: 'Identificação pendente' } as Record<string, string>)[key] ?? fallback;
}
export function healthGuidance(key: string, code: string): string {
  if (key === 'UNKNOWN_EXECUTIONS' || key === 'INTEGRATION_UNCERTAINTY') return 'Resultado incerto não significa que a mensagem não foi enviada. Confira o recibo e o histórico antes de decidir por uma nova tentativa.';
  if (code === 'AUTOMATION_RUNTIME_DISABLED') return 'O processamento de automações está desativado nesta configuração.';
  if (code === 'WORKER_NEVER_OBSERVED') return 'Ainda não há sinal de atividade registrado para este processo.';
  if (code === 'WORKER_HEARTBEAT_STALE') return 'O último sinal de atividade está atrasado. Verifique o processo e sua fila.';
  if (key === 'CHATWOOT') return 'O sinal considera destinos aprovados e o estado registrado da integração. Verifique conexão, identidade e últimas entregas.';
  if (key === 'EVOLUTION' || key === 'META') return 'Quantidade de caixas prontas ou conectadas no cadastro. Consulte cada canal para verificar a sessão.';
  if (key === 'QR_IDENTITY_PENDING') return 'Eventos aguardam conciliação da identidade do número com a caixa correta.';
  if (key === 'INTEGRATION_FAILURES' || key === 'FAILED_EXECUTIONS') return 'Registros acumulados com falha. Investigue a causa e a data antes de qualquer reprocessamento.';
  if (key === 'QUEUE') return 'Itens registrados na outbox de mensagens e na fila de automações. Esta contagem não abrange todas as filas do sistema.';
  if (key === 'OUTBOX_AGE') return 'Tempo do registro mais antigo nas outboxes consultadas, incluindo resultado incerto em automações.';
  return 'Sinal reportado pela API na última consulta. Expanda os detalhes para consultar o código de diagnóstico.';
}
export function healthDestination(key: string): { to: string; label: string } | null {
  if (['CHATWOOT', 'INTEGRATION_FAILURES', 'INTEGRATION_UNCERTAINTY', 'QR_IDENTITY_PENDING'].includes(key)) return { to: '/integracoes', label: 'Ver integrações' };
  if (['EVOLUTION', 'META'].includes(key)) return { to: '/channels', label: 'Ver conexões' };
  if (['UNKNOWN_EXECUTIONS', 'FAILED_EXECUTIONS', 'AUTOMATION_WORKER', 'AUTOMATION_IO_WORKER'].includes(key)) return { to: '/automation-executions', label: 'Ver execuções' };
  return null;
}
