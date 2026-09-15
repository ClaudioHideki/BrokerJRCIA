// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Instance } from '@jrc/contracts';

import type { ApiClient } from '../api/client.js';
import { useInstancePolling } from './use-instance-polling.js';

const INSTANCE_ID = '519b77a6-a4e5-409a-85c8-d78fc155c525';
const instance: Instance = {
  id: INSTANCE_ID,
  organizationId: '92776cb0-bcba-45c0-98a3-2937fefdfdaf',
  providerAccountId: '6fd7933a-80b7-4491-b081-a0fa8c2414d2',
  name: 'Atendimento',
  provider: 'BAILEYS',
  status: 'CONNECTING',
  createdAt: '2030-01-01T12:00:00.000Z',
  updatedAt: '2030-01-01T12:00:00.000Z',
};

function client(request: ApiClient['request'], purge: ApiClient['registerTenantPurge'] = vi.fn(() => () => undefined)): ApiClient {
  return { request, registerTenantPurge: purge } as unknown as ApiClient;
}

describe('useInstancePolling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('consulta imediatamente, espera a resposta e só agenda novamente após quatro segundos', async () => {
    let release: ((value: unknown) => void) | undefined;
    const request = vi.fn(() => new Promise((resolve) => { release = resolve; })) as ApiClient['request'];
    const onStatus = vi.fn();
    renderHook(() => useInstancePolling({
      client: client(request), instanceId: INSTANCE_ID, active: true, onStatus, onError: vi.fn(),
    }));
    expect(request).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(8_000); });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { release?.(instance); await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(3_999); });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('aborta no purge de tenant e não publica resposta tardia', async () => {
    let purge: (() => void) | undefined;
    let release: ((value: unknown) => void) | undefined;
    const registerTenantPurge = vi.fn((handler: () => void) => {
      purge = handler;
      return () => { purge = undefined; };
    });
    const request = vi.fn((_path: string, init?: RequestInit) => new Promise((resolve, reject) => {
      release = resolve;
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })) as ApiClient['request'];
    const onStatus = vi.fn();
    renderHook(() => useInstancePolling({
      client: client(request, registerTenantPurge), instanceId: INSTANCE_ID, active: true,
      onStatus, onError: vi.fn(),
    }));
    expect(request).toHaveBeenCalledTimes(1);
    act(() => purge?.());
    await act(async () => { release?.(instance); await Promise.resolve(); });
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('recupera de erro transitório sem sobrepor requisições', async () => {
    let releaseSecond: ((value: unknown) => void) | undefined;
    const request = vi.fn()
      .mockRejectedValueOnce(new Error('falha transitória'))
      .mockImplementationOnce(() => new Promise((resolve) => { releaseSecond = resolve; }))
      .mockResolvedValue(instance) as ApiClient['request'];
    const onStatus = vi.fn();
    const onError = vi.fn();
    renderHook(() => useInstancePolling({
      client: client(request), instanceId: INSTANCE_ID, active: true,
      onStatus, onError, intervalMs: 1_000,
    }));

    await act(async () => { await Promise.resolve(); });
    expect(onError).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(request).toHaveBeenCalledTimes(2);

    await act(async () => { releaseSecond?.(instance); await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(request).toHaveBeenCalledTimes(3);
    expect(onStatus).toHaveBeenCalledWith(instance);
  });

  it('pausa oculta, retoma visível e aborta definitivamente ao desmontar', async () => {
    const signals: AbortSignal[] = [];
    const request = vi.fn((_path: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      if (init?.signal) {
        signals.push(init.signal);
        init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }
    })) as ApiClient['request'];
    const onError = vi.fn();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const rendered = renderHook(() => useInstancePolling({
      client: client(request), instanceId: INSTANCE_ID, active: true,
      onStatus: vi.fn(), onError, intervalMs: 1_000,
    }));

    expect(request).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(request).toHaveBeenCalledTimes(1);

    visibility.mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(request).toHaveBeenCalledTimes(2);
    rendered.unmount();
    expect(signals[1]?.aborted).toBe(true);
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(request).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });
});
