import { useLayoutEffect, useState } from 'react';
import { Link } from 'react-router';
import { useApiClient, useSession } from '../auth/SessionProvider.js';
interface Limits { status:string;maxInstances:number;maxUsers:number;messagesPerDay:number;maxPendingMessages:number;messagesAcceptedToday:number }
export function CompanyPage() {
  const client=useApiClient(); const {session,tenantRevision}=useSession(); const [limits,setLimits]=useState<Limits|null>(null);const [error,setError]=useState('');
  useLayoutEffect(()=>{const controller=new AbortController();setLimits(null);setError('');void client.request<Limits>('/v1/organization/operations',{signal:controller.signal}).then(data=>{if(!controller.signal.aborted)setLimits(data);}).catch(()=>{if(!controller.signal.aborted)setError('Não foi possível consultar os limites. Tente novamente mais tarde.');});return()=>controller.abort();},[client,tenantRevision,session?.activeOrganization.id]);
  return <section className="page-content"><h1>Minha empresa</h1><p>{session?.activeOrganization.name}</p>{error&&<p role="alert" className="notice notice--error">{error}</p>}
    {limits?<><p className="notice" role="status">{limits.status==='ACTIVE'?'Operação ativa':'Operação suspensa: novos envios bloqueados e pendências preservadas.'}</p><dl className="platform-metrics">
      <div><dt>Envios aceitos hoje (UTC)</dt><dd>{limits.messagesAcceptedToday} / {limits.messagesPerDay}</dd></div><div><dt>Limite de conexões</dt><dd>{limits.maxInstances}</dd></div><div><dt>Limite de usuários</dt><dd>{limits.maxUsers}</dd></div><div><dt>Limite de mensagens pendentes</dt><dd>{limits.maxPendingMessages}</dd></div></dl></>:!error&&<p role="status">Consultando limites…</p>}
    <div className="connection-grid"><section className="panel"><h2>Conectar WhatsApp</h2><p>Escolha o canal oficial ou o pareamento por QR.</p><div className="dialog-actions"><Link to="/whatsapp-oficial" className="button button--primary">WhatsApp oficial</Link><Link to="/conexoes/nova" className="button button--secondary">Conectar por QR</Link></div></section>
      <section className="panel"><h2>Automatizar atendimento</h2><p>Crie ou importe um chatbot JRC, publique e vincule-o a uma caixa de entrada.</p><Link to="/automations" className="button button--primary">Abrir automações</Link></section></div>
    <p>Para alterar o plano, responsáveis ou limites contratados, solicite atendimento à equipe JRC.</p></section>;
}
