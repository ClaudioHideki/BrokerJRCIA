import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import type { ApiClient } from '../api/client.js';
import { ChatwootPanel, type IntegrationRequest } from '../integrations/ChatwootPanel.js';

export function SetupDestination({ client, companyName, disabled }: { client: ApiClient; companyName: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const request = useCallback<IntegrationRequest>((path, method = 'GET', body, options) => client.request(`/v1/integrations/chatwoot${path}`, {
    method, ...(options ? { headers: { 'Idempotency-Key': options.idempotencyKey } } : {}), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), [client]);
  return <section className="panel"><h3>Empresa e destino</h3><p>Esta configuração pertence à empresa exibida acima.</p>
    <p><Link to="/minha-empresa">Conferir dados da empresa</Link></p>
    <p>Configure a instalação JRC, a conta e a credencial nos campos protegidos. A aprovação de um destino externo continua sob a administração JRC.</p>
    <button className="button button--secondary" onClick={() => setOpen(value => !value)}>{open ? 'Fechar destino JRC' : 'Configurar destino JRC'}</button>
    {open && <ChatwootPanel companyName={companyName} platform={false} canManage={!disabled} request={request} />}
  </section>;
}
