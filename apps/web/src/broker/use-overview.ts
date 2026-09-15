import { useLayoutEffect, useRef, useState } from 'react';
import { BrokerOverviewSchema, type BrokerOverview } from '@jrc/contracts';
import { useApiClient, useSession } from '../auth/SessionProvider.js';
export function useOverview(days = 30) {
  const client = useApiClient();
  const { session, tenantRevision } = useSession();
  const [data, setData] = useState<BrokerOverview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  useLayoutEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    setData(null);
    setError('');
    setLoading(true);
    const purge = () => {
      generation.current++;
      controller.abort();
      setData(null);
      setError('');
      setLoading(true);
    };
    const unregister = client.registerTenantPurge(purge);
    void client
      .request<unknown>('/v1/organization/overview?days=' + days, { signal: controller.signal })
      .then((value) => {
        if (current !== generation.current || controller.signal.aborted) return;
        const parsed = BrokerOverviewSchema.safeParse(value);
        if (!parsed.success) throw new Error('Invalid summary');
        setData(parsed.data);
      })
      .catch(() => {
        if (current === generation.current && !controller.signal.aborted)
          setError('Não foi possível atualizar os indicadores. Tente novamente.');
      })
      .finally(() => {
        if (current === generation.current && !controller.signal.aborted) setLoading(false);
      });
    return () => {
      purge();
      unregister();
    };
  }, [client, session?.activeOrganization.id, tenantRevision, days, revision]);
  return { data, error, loading, refresh: () => setRevision((v) => v + 1) };
}
