// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { ConnectionHealth } from '@jrc/contracts';
import { ConnectionHealthSummary } from './ConnectionHealthSummary.js';

const health: ConnectionHealth = {
  integrationId: '884c4ce2-741f-47a1-b9a2-ccfbcbb60231', instanceId: '884c4ce2-741f-47a1-b9a2-ccfbcbb60231', inboxId: 1,
  integrationStatus: 'READY', instanceStatus: 'CONNECTED', transportStatus: 'UNVERIFIED',
  identityStatus: 'CONFIRMATION_REQUIRED', identityApproved: false, identityRevision: 3,
  observedNumberSuffix: '0100', checkedAt: '2026-09-29T10:00:00.000Z', lastError: null,
  callbackVerifiedAt: null, lastSuccessfulInboundAt: null, lastSuccessfulOutboundAt: null,
  allowedActions: ['status'],
};

it('does not treat a connected session and configured inbox as verified delivery', () => {
  render(<ConnectionHealthSummary health={health} />);
  expect(screen.getByText('Vínculo configurado')).toBeVisible();
  expect(screen.getByText('Aguardando confirmação do número')).toBeVisible();
  expect(screen.getByText('Entrega ainda não comprovada')).toBeVisible();
  expect(screen.queryByText('Entrega verificada')).not.toBeInTheDocument();
  expect(screen.getByText(/Final observado: 0100/)).toBeVisible();
});

it('requires inbound and outbound evidence and displays their timestamps', () => {
  render(<ConnectionHealthSummary health={{ ...health, transportStatus: 'OPERATIONAL', identityApproved: true,
    identityStatus: 'CONFIRMED', callbackVerifiedAt: health.checkedAt,
    lastSuccessfulInboundAt: health.checkedAt, lastSuccessfulOutboundAt: health.checkedAt }} />);
  expect(screen.getByText('Entrega verificada')).toBeVisible();
  expect(screen.getAllByText(/29\/09\/2026/).length).toBeGreaterThan(2);
});

it('never promotes stale or incomplete evidence to operational status', () => {
  render(<ConnectionHealthSummary health={{ ...health, transportStatus: 'OPERATIONAL', identityApproved: true,
    identityStatus: 'CONFIRMED', callbackVerifiedAt: health.checkedAt,
    lastSuccessfulInboundAt: health.checkedAt, lastSuccessfulOutboundAt: null }} />);
  expect(screen.queryByText('Entrega verificada')).not.toBeInTheDocument();
  expect(screen.getByText('Entrega ainda não comprovada')).toBeVisible();
});
