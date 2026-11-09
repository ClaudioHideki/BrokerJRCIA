// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { useGuidedSetup } from './useGuidedSetup.js';
import { SetupReview } from './SetupReview.js';
const org = '11111111-1111-4111-8111-111111111111';
it('does not send a saved callback after leaving its tenant scope', async () => {
  const request = vi.fn(async (path: string) => path.endsWith('/availability') ? { enabled: true } : { data: [] });
  const client = { request } as unknown as ApiClient;
  const { result, unmount } = renderHook(() => useGuidedSetup(client, org));
  await waitFor(() => expect(result.current.loading).toBe(false));
  const create = result.current.create; unmount(); request.mockClear();
  await act(async () => { await create('Late callback', 'QR'); });
  expect(request).not.toHaveBeenCalled();
});
it('offers stopping an uncertain test using the freshly read owner revision', async () => {
  const row: any = { id: org, organizationId: org, selection: { transport: 'QR', channelId: org }, state: 'UNKNOWN',
    pendingAction: 'TEST', readiness: null, proof: null, test: { keyword: 'teste-exclusivo' } };
  const action = vi.fn(), request = vi.fn(async () => ({ binding: null, ownerRevision: 7 }));
  render(<MemoryRouter><SetupReview client={{ request } as unknown as ApiClient} row={row} busy={false} action={action} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Interromper teste ou atendimento' }));
  await waitFor(() => expect(action).toHaveBeenCalledWith('deactivate', { expectedOwnerRevision: 7 }));
});
