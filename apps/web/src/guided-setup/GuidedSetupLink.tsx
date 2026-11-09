import { useLayoutEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ApiClient } from '../api/client.js';
export function GuidedSetupLink({ client, organizationId, canManage }: { client: ApiClient; organizationId?: string | undefined; canManage: boolean }) {
  const [enabled, setEnabled] = useState(false);
  useLayoutEffect(() => {
    let alive = true; setEnabled(false);
    if (canManage && organizationId) void client.request<{ enabled: boolean }>('/v1/guided-setups/availability').then(value => {
      if (alive) setEnabled(value.enabled === true);
    }).catch(() => {});
    return () => { alive = false; };
  }, [client, organizationId, canManage]);
  return enabled ? <p><Link className="button button--secondary" to="/configuracao-guiada">Configurar atendimento guiado</Link></p> : null;
}
