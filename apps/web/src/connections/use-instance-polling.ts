import { useEffect } from 'react';

import type { Instance } from '@jrc/contracts';

import type { ApiClient } from '../api/client.js';
import { getConnectionStatus } from './api.js';

export interface InstancePollingOptions {
  client: ApiClient;
  instanceId: string;
  active: boolean;
  onStatus(instance: Instance): void;
  onError(error: unknown): void;
  intervalMs?: number;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function useInstancePolling({
  client,
  instanceId,
  active,
  onStatus,
  onError,
  intervalMs = 4_000,
}: InstancePollingOptions): void {
  useEffect(() => {
    if (!active) return undefined;
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const clear = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      controller?.abort();
      controller = undefined;
    };

    const schedule = () => {
      if (stopped || document.visibilityState === 'hidden') return;
      timer = setTimeout(() => { void poll(); }, intervalMs);
    };

    const poll = async () => {
      if (stopped || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      controller = new AbortController();
      try {
        const result = await getConnectionStatus(client, instanceId, controller.signal);
        if (!stopped) onStatus(result);
      } catch (error) {
        if (!stopped && !isAbort(error)) onError(error);
      } finally {
        inFlight = false;
        controller = undefined;
        if (!stopped) schedule();
      }
    };

    const visibilityChanged = () => {
      clear();
      if (document.visibilityState !== 'hidden' && !stopped) void poll();
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    const unregisterPurge = client.registerTenantPurge(() => {
      stopped = true;
      clear();
    });
    void poll();

    return () => {
      stopped = true;
      clear();
      unregisterPurge();
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [active, client, instanceId, intervalMs, onError, onStatus]);
}
