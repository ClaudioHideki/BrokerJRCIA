// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';
import { OperationalHealthPage } from './OperationalHealth.js';

const context = vi.hoisted(() => ({ client: { request: vi.fn() } }));
vi.mock('../auth/SessionProvider.js', () => ({ useApiClient: () => context.client }));
const snapshot = (name = 'PostgreSQL') => ({
  observedAt: '2026-10-30T12:00:00.000Z', overall: 'DEGRADED',
  components: [
    { key: 'DATABASE', label: name, state: 'UP', code: 'DATABASE_READY', observedAt: null },
    { key: 'CHATWOOT', label: 'Chatwoot', state: 'UP', code: 'CHATWOOT_READY', observedAt: null },
    { key: 'INTEGRATION_FAILURES', label: 'Falhas', state: 'DEGRADED', code: 'FAILURES', observedAt: null, metric: 12, unit: 'items' },
    { key: 'UNKNOWN_EXECUTIONS', label: 'Execuções incertas', state: 'DEGRADED', code: 'UNKNOWN_EXECUTIONS', observedAt: null, metric: 2, unit: 'executions' },
  ], alerts: [{ component: 'UNKNOWN_EXECUTIONS', state: 'DEGRADED', code: 'UNKNOWN_EXECUTIONS' }],
});
const page = () => <MemoryRouter><OperationalHealthPage /></MemoryRouter>;
afterEach(() => { vi.useRealTimers(); context.client = { request: vi.fn() }; });

it('separates current signals from accumulated failures and does not promise delivery', async () => {
  context.client.request.mockResolvedValue(snapshot()); render(page());
  expect(await screen.findByRole('heading', { name: 'Infraestrutura e processos' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Canais e integrações' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Filas e registros acumulados' })).toBeVisible();
  expect(screen.getByText(/não comprovam a entrega de mensagens/i)).toBeVisible();
  expect(screen.getByText(/podem incluir falhas antigas/i)).toBeVisible();
  expect(screen.getAllByText(/não significa que a mensagem não foi enviada/i)[0]).toBeVisible();
  expect(screen.queryByRole('button', { name: /reenviar|reprocessar/i })).not.toBeInTheDocument();
});

it('marks retained data as stale after refresh failure and can recover', async () => {
  context.client.request.mockResolvedValueOnce(snapshot()).mockRejectedValueOnce(new Error('secret must not render')).mockResolvedValue(snapshot());
  render(page()); await screen.findByRole('heading', { name: 'PostgreSQL' });
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/dados desatualizados/i);
  expect(screen.getByRole('heading', { name: 'PostgreSQL' })).toBeVisible();
  expect(screen.queryByText(/secret must not render/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
});

it('never overlaps polling while a request is pending', async () => {
  vi.useFakeTimers(); context.client.request.mockReturnValue(new Promise(() => {})); render(page());
  await act(async () => { vi.advanceTimersByTime(19_000); });
  expect(context.client.request).toHaveBeenCalledTimes(1);
});

it('aborts a stalled request, releases refresh and ignores its late result', async () => {
  vi.useFakeTimers(); let resolveLate!: (value: unknown) => void;
  context.client.request.mockReturnValueOnce(new Promise(resolve => { resolveLate = resolve; })).mockResolvedValueOnce(snapshot('Consulta recuperada'));
  render(page());
  await act(async () => { vi.advanceTimersByTime(20_000); });
  expect(context.client.request.mock.calls[0]?.[1].signal.aborted).toBe(true);
  expect(screen.getByRole('alert')).toBeVisible();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Atualizar' })); });
  expect(screen.getByRole('heading', { name: 'Consulta recuperada' })).toBeVisible();
  await act(async () => resolveLate(snapshot('Resposta expirada')));
  expect(screen.queryByText('Resposta expirada')).not.toBeInTheDocument();
});

it('discards late responses from a previous company/client', async () => {
  let resolveOld!: (value: unknown) => void;
  context.client.request.mockReturnValue(new Promise(resolve => { resolveOld = resolve; }));
  const view = render(page());
  context.client = { request: vi.fn().mockResolvedValue(snapshot('Banco da empresa atual')) };
  view.rerender(page()); await screen.findByRole('heading', { name: 'Banco da empresa atual' });
  await act(async () => resolveOld(snapshot('Banco da empresa anterior')));
  expect(screen.queryByText('Banco da empresa anterior')).not.toBeInTheDocument();
});

it('handles malformed responses and empty valid snapshots without crashing', async () => {
  context.client.request.mockResolvedValueOnce({ components: 'invalid' }).mockResolvedValueOnce({ ...snapshot(), components: [], alerts: [] });
  render(page()); expect(await screen.findByRole('alert')).toHaveTextContent(/não foi possível/i);
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
  expect(await screen.findByText(/nenhum componente informado/i)).toBeVisible();
});

it('provides an accessible local theme switch', async () => {
  context.client.request.mockResolvedValue(snapshot()); render(page());
  await screen.findByRole('heading', { name: 'PostgreSQL' });
  const toggle = screen.getByRole('button', { name: 'Tema escuro nesta área' });
  fireEvent.click(toggle); expect(toggle).toHaveAttribute('aria-pressed', 'true');
});

it('has no automated accessibility violations in the pilot region', async () => {
  context.client.request.mockResolvedValue(snapshot()); const { container } = render(page());
  await screen.findByRole('heading', { name: 'PostgreSQL' });
  const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  expect(results.violations).toEqual([]);
});
