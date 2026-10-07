import { useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { useSession,useApiClient } from '../auth/SessionProvider.js';
import {CentralChannelSetup} from '../channels/CentralChannelSetup.js';
import { NewConnectionPage } from './NewConnection.js';

const steps = ['Conectar WhatsApp', 'Escolher central e conta', 'Vincular caixa de destino', 'Confirmar número e testar', 'Ativar Flow (opcional)'];
export function NewChannelPage() {
  const { session,tenantRevision } = useSession(); const client=useApiClient(); const [query, setQuery] = useSearchParams();
  const initial = query.get('provider');
  const [provider, setProvider] = useState<'qr' | 'meta' | 'central' | null>(() => initial === 'qr' || initial === 'meta' || initial==='central' ? initial : null);
  if (session?.activeOrganization.role === 'VIEWER') return <Navigate replace to="/channels" />;
  if (provider === 'meta') return <Navigate replace to="/channels/meta/connect" />;
  return <section aria-labelledby="new-channel-title"><Link className="back-link" to="/channels">← Voltar para caixas de entrada</Link>
    <p className="eyebrow">Novo canal</p><h1 id="new-channel-title">Configurar canal</h1>
    <ol className="wizard-steps" aria-label="Etapas da configuração">{steps.map((step, index) => <li className={index === 0 ? 'active' : ''} aria-current={index === 0 ? 'step' : undefined} key={step}><span>{index + 1}</span>{step}</li>)}</ol>
    <p>Depois de criar o WhatsApp, continue na mesma conexão para configurar atendimento e Flow. O cadastro salvo permanece disponível em Caixas de entrada.</p>
    {!provider ? <div className="provider-cards"><button className="panel provider-card" onClick={() => { setProvider('qr'); setQuery({ provider: 'qr' }, { replace: true }); }}>
      <strong>WhatsApp por QR Code</strong><span>Leia o QR Code em Aparelhos conectados do seu WhatsApp.</span></button>
      <button className="panel provider-card" onClick={() => { setProvider('meta'); setQuery({ provider: 'meta' }, { replace: true }); }}>
        <strong>WhatsApp oficial Meta</strong><span>Autorize uma conta pela configuração incorporada da Meta.</span></button>
      {session&&['OWNER','ADMIN'].includes(session.activeOrganization.role)&&<button className="panel provider-card" onClick={()=>{setProvider('central');setQuery({provider:'central'},{replace:true});}}><strong>Caixa já conectada na central</strong><span>Usar o WhatsApp existente no JRC Conversas ou Chatwoot com o Flow do Broker.</span></button>}</div> : null}
    {provider === 'qr' ? <NewConnectionPage canonical /> : null}
    {provider==='central'&&session&&['OWNER','ADMIN'].includes(session.activeOrganization.role)&&<CentralChannelSetup key={`${session.activeOrganization.id}:${tenantRevision}`} organizationId={session.activeOrganization.id} tenantRevision={tenantRevision} client={client} operationId={query.get('operation')??undefined} channelId={query.get('channel')??undefined} onOperation={id=>setQuery({provider:'central',operation:id},{replace:true})}/>}
  </section>;
}
