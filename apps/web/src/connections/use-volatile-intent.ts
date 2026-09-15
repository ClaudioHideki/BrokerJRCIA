import { useCallback, useEffect, useMemo, useRef } from 'react';

import type { ApiClient } from '../api/client.js';

export interface VolatileIntent {
  acquire(options?: { forceNew?: boolean }): string;
  complete(): void;
  clear(): void;
}

export function useVolatileIntent(client: ApiClient): VolatileIntent {
  const key = useRef<string | null>(null);
  const clear = useCallback(() => { key.current = null; }, []);
  const acquire = useCallback((options?: { forceNew?: boolean }) => {
    if (key.current === null || options?.forceNew) key.current = crypto.randomUUID();
    return key.current;
  }, []);

  useEffect(() => {
    const unregister = client.registerTenantPurge(clear);
    return () => {
      clear();
      unregister();
    };
  }, [clear, client]);

  return useMemo(() => ({ acquire, complete: clear, clear }), [acquire, clear]);
}
