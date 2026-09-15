import type { InstanceStatus } from '@jrc/contracts';

const STATUS_VIEWS: Record<InstanceStatus, { label: string; symbol: string; tone: string }> = {
  PROVISIONING: { label: 'Provisionando', symbol: '◷', tone: 'pending' },
  CREATED: { label: 'Criada', symbol: '●', tone: 'neutral' },
  PROVISIONING_FAILED: { label: 'Falha no provisionamento', symbol: '!', tone: 'danger' },
  CONNECTING: { label: 'Conectando', symbol: '◷', tone: 'pending' },
  AWAITING_ACTION: { label: 'Aguardando ação', symbol: '◇', tone: 'warning' },
  CONNECTED: { label: 'Conectada', symbol: '✓', tone: 'success' },
  DISCONNECTING: { label: 'Desconectando', symbol: '◷', tone: 'pending' },
  DISCONNECTED: { label: 'Desconectada', symbol: '○', tone: 'neutral' },
  ERROR: { label: 'Erro', symbol: '!', tone: 'danger' },
};

export function connectionStatusView(status: InstanceStatus) {
  return STATUS_VIEWS[status];
}

export function isPollingStatus(status: InstanceStatus): boolean {
  return ['PROVISIONING', 'CONNECTING', 'AWAITING_ACTION', 'DISCONNECTING'].includes(status);
}

export function canConnect(status: InstanceStatus): boolean {
  return ['CREATED', 'DISCONNECTED', 'ERROR', 'AWAITING_ACTION', 'CONNECTING'].includes(status);
}

export function canDisconnect(status: InstanceStatus): boolean {
  return ['CONNECTED', 'AWAITING_ACTION', 'ERROR'].includes(status);
}
