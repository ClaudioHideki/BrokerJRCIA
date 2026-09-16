// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { DashboardAppSetup } from './DashboardAppSetup.js';
const embedId = '884c4ce2-741f-47a1-b9a2-ccfbcbb60231';
const setup = { embedId, title: 'Conexões JRC', url: `https://broker.example.test/embed/chatwoot/${embedId}`, state: 'UNCONFIGURED', remoteAppId: null };
it('generates name and URL only on explicit request, supports manual install and reconciliation', async () => {
  const request = vi.fn().mockResolvedValueOnce({ embedId }).mockResolvedValueOnce(setup).mockResolvedValueOnce({ ...setup, state: 'MANUAL' });
  render(<DashboardAppSetup request={request} />); expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Preparar painel do Chatwoot' }));
  expect(await screen.findByDisplayValue(setup.url)).toHaveAttribute('readonly');
  fireEvent.click(screen.getByRole('button', { name: 'Instalar ou conferir aplicativo' }));
  expect(await screen.findByText(/cadastro automático indisponível/i)).toBeVisible();
  expect(request).toHaveBeenLastCalledWith(`/embed-apps/${embedId}/install`, 'POST', {});
  expect(screen.getByRole('link', { name: 'Operar pelo portal JRC' })).toHaveAttribute('href', '/conexoes');
});
it('handles a disabled capability without hiding the independent portal', async () => {
  render(<DashboardAppSetup request={vi.fn().mockRejectedValue(new Error('private-diagnostic'))} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preparar painel do Chatwoot' }));
  expect(await screen.findByRole('alert')).not.toHaveTextContent('private-diagnostic');
  expect(screen.getByRole('link', { name: 'Operar pelo portal JRC' })).toBeVisible();
});
