import { describe, expect, it } from 'vitest';

import type { InstanceStatus } from '@jrc/contracts';

import { connectionStatusView, isPollingStatus } from './status.js';

describe('connectionStatusView', () => {
  it('oferece texto e símbolo para todos os estados canônicos', () => {
    const labels = [
      ['PROVISIONING', 'Provisionando'],
      ['CREATED', 'Criada'],
      ['PROVISIONING_FAILED', 'Falha no provisionamento'],
      ['CONNECTING', 'Conectando'],
      ['AWAITING_ACTION', 'Aguardando ação'],
      ['CONNECTED', 'Conectada'],
      ['DISCONNECTING', 'Desconectando'],
      ['DISCONNECTED', 'Desconectada'],
      ['ERROR', 'Erro'],
    ] as const;

    for (const [status, label] of labels) {
      expect(connectionStatusView(status)).toMatchObject({ label });
      expect(connectionStatusView(status).symbol.length).toBeGreaterThan(0);
    }
  });

  it('acompanha somente estados que ainda podem mudar sem nova intenção', () => {
    const transient: InstanceStatus[] = [
      'PROVISIONING',
      'CONNECTING',
      'AWAITING_ACTION',
      'DISCONNECTING',
    ];
    const terminal: InstanceStatus[] = [
      'CREATED',
      'PROVISIONING_FAILED',
      'CONNECTED',
      'DISCONNECTED',
      'ERROR',
    ];
    expect(transient.filter(isPollingStatus)).toEqual([
      'PROVISIONING',
      'CONNECTING',
      'AWAITING_ACTION',
      'DISCONNECTING',
    ]);
    expect(terminal.filter(isPollingStatus)).toEqual([]);
  });
});
