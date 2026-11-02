import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client.js';
import { parseHealthSnapshot, type HealthSnapshot } from './health-model.js';

interface Observation { owner: ApiClient; data: HealthSnapshot | null; loading: boolean; failed: boolean }
export function useOperationalHealth(client: ApiClient) {
  const [observation, setObservation] = useState<Observation>({ owner: client, data: null, loading: true, failed: false });
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    let active = true, inFlight = false;
    let controller: AbortController | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    setObservation({ owner: client, data: null, loading: true, failed: false });
    const load = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      setObservation(previous => ({ ...previous, loading: true }));
      try {
        controller = new AbortController();
        const timeout = new Promise<never>((_, reject) => {
          deadline = setTimeout(() => { controller?.abort(); reject(new Error('Health request timed out')); }, 20_000);
        });
        const data = parseHealthSnapshot(await Promise.race([
          client.request<unknown>('/v1/operations/health', { signal: controller.signal }), timeout,
        ]));
        if (active) setObservation({ owner: client, data, loading: false, failed: false });
      } catch {
        if (active) setObservation(previous => ({ ...previous, loading: false, failed: true }));
      } finally { clearTimeout(deadline); inFlight = false; }
    };
    refresh.current = () => { void load(); };
    void load();
    const timer = setInterval(() => { void load(); }, 30_000);
    return () => { active = false; controller?.abort(); clearTimeout(deadline); clearInterval(timer); refresh.current = () => {}; };
  }, [client]);
  // Hide the previous company's snapshot even in the render before effect cleanup.
  const current = observation.owner === client ? observation : { data: null, loading: true, failed: false };
  return { ...current, refresh: () => refresh.current() };
}
