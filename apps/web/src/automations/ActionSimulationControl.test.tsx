// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ActionSimulationControl } from './ActionSimulationControl.js';
const wait = { nodeId: 'action', operation: 'note' as const, waitId: '11111111-2222-4333-8444-555555555555' };
it('sends only the synthetic outcome for the exact current wait', () => {
  const response = vi.fn();
  render(<ActionSimulationControl wait={wait} disabled={false} onResponse={response} />);
  fireEvent.click(screen.getByRole('button', { name: 'Aplicar resultado fictício' }));
  expect(response).toHaveBeenCalledWith({ type: 'ACTION_RESPONSE', nodeId: 'action', waitId: wait.waitId, outcome: 'success' });
  expect(screen.queryByText(wait.waitId)).toBeNull();
});
it('describes uncertainty as pending reconciliation instead of a next branch', () => {
  const response = vi.fn();
  render(<ActionSimulationControl wait={wait} disabled={false} onResponse={response} />);
  fireEvent.change(screen.getByLabelText('Resultado fictício da ação'), { target: { value: 'unknown' } });
  expect(screen.getByText(/permanece aguardando confirmação.*não avança/i)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Aplicar resultado fictício' }));
  expect(response).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'unknown', waitId: wait.waitId }));
});
it('makes resolve explicit and resets a selected outcome when the wait changes', () => {
  const response = vi.fn();
  const { rerender } = render(<ActionSimulationControl wait={wait} disabled={false} onResponse={response} />);
  fireEvent.change(screen.getByLabelText('Resultado fictício da ação'), { target: { value: 'error' } });
  rerender(<ActionSimulationControl wait={{ ...wait, operation: 'resolve', waitId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }} disabled={false} onResponse={response} />);
  expect(screen.getByLabelText('Resultado fictício da ação')).toHaveValue('success');
  expect(screen.getByText(/encerra o ciclo.*sem próxima mensagem/i)).toBeVisible();
});
it('cannot submit while disabled', () => {
  const response = vi.fn();
  render(<ActionSimulationControl wait={wait} disabled onResponse={response} />);
  expect(screen.getByRole('button', { name: 'Aplicar resultado fictício' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Aplicar resultado fictício' }));
  expect(response).not.toHaveBeenCalled();
});
