import { useEffect, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { useSession } from '../auth/SessionProvider.js';
import { NewConnectionPage } from './NewConnection.js';

const steps = ['Conectar WhatsApp', 'Vincular atendimento', 'Ativar automação'];
export function NewChannelPage() {
  const { session } = useSession(); const [query, setQuery] = useSearchParams();
  const initial = query.get('provider');
  const [provider, setProvider] = useState<'qr' | 'meta' | null>(() => initial === 'qr' || initial === 'meta' ? initial : null);
  useEffect(() => { if (provider) sessionStorage.setItem('jrc-channel-wizard', JSON.stringify({ step: 2, provider })); }, [provider]);
  if (session?.activeOrganization.role === 'VIEWER') return <Navigate replace to="/channels" />;
  if (provider === 'meta') return <Navigate replace to="/channels/meta/connect" />;
  return <section aria-labelledby="new-channel-title"><Link className="back-link" to="/channels">← Voltar para caixas de entrada</Link>
    <p className="eyebrow">Novo canal</p><h1 id="new-channel-title">Configurar canal</h1>
    <ol className="wizard-steps" aria-label="Etapas da configuração">{steps.map((step, index) => <li className={index <= (provider ? 1 : 0) ? 'active' : ''} key={step}><span>{index + 1}</span>{step}</li>)}</ol>
    {!provider ? <div className="provider-cards"><button className="panel provider-card" onClick={() => { setProvider('qr'); setQuery({ provider: 'qr' }, { replace: true }); }}>
      <strong>WhatsApp por QR Code</strong><span>Leia o QR Code em Aparelhos conectados do seu WhatsApp.</span></button>
      <button className="panel provider-card" onClick={() => { setProvider('meta'); setQuery({ provider: 'meta' }, { replace: true }); }}>
        <strong>WhatsApp oficial Meta</strong><span>Autorize uma conta pela configuração incorporada da Meta.</span></button></div> : null}
    {provider === 'qr' ? <NewConnectionPage canonical /> : null}
  </section>;
}
