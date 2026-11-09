import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { ApiClient } from '../api/client.js';
import { useApiClient, useSession } from '../auth/SessionProvider.js';
import { useGuidedSetup } from './useGuidedSetup.js';
import { SetupSteps } from './SetupSteps.js';
import { SetupReview } from './SetupReview.js';
import { SetupDestination } from './SetupDestination.js';
import { SetupTransport } from './SetupTransport.js';
import { SetupConnections } from './SetupConnections.js';
import { SetupRobot } from './SetupRobot.js';
import './guided-setup.css';

export function GuidedSetupPage() {
  const client = useApiClient(), { session, tenantRevision } = useSession(), { id } = useParams(), navigate = useNavigate();
  if (!session) return null;
  if (!['OWNER', 'ADMIN'].includes(session.activeOrganization.role)) return <p>O administrador da empresa pode configurar os vínculos de atendimento.</p>;
  return <GuidedSetupSurface key={`${session.activeOrganization.id}:${tenantRevision}:${id ?? ''}`} client={client}
    organizationId={session.activeOrganization.id} organizationName={session.activeOrganization.name} {...(id ? { setupId: id } : {})}
    onCreated={newId => navigate(`/configuracao-guiada/${newId}`)} />;
}
export function GuidedSetupSurface({ client, organizationId, organizationName, setupId, onCreated }: {
  client: ApiClient; organizationId: string; organizationName: string; setupId?: string; onCreated?(id: string): void;
}) {
  const model = useGuidedSetup(client, organizationId, setupId);
  const [name, setName] = useState(''), [transport, setTransport] = useState<'QR' | 'META'>('QR'), [step, setStep] = useState(0);
  useEffect(() => { setName(''); setTransport('QR'); setStep(0); }, [organizationId, setupId]);
  useEffect(() => { if (model.row && ['UNKNOWN', 'TESTING', 'ACTIVE'].includes(model.row.state)) setStep(4); }, [model.row?.state]);
  const row = model.row;
  const disabled = model.busy || !row || !['EDITING', 'REVIEW'].includes(row.state);
  return <section className="form-page guided-setup" aria-labelledby="guided-setup-title">
    <Link className="back-link" to="/channels">← Caixas de entrada</Link>
    <h1 id="guided-setup-title">Configuração guiada</h1><p>Empresa: <strong>{organizationName}</strong></p>
    {model.error && <p role="alert">{model.error}</p>}
    {model.loading ? <p role="status">Consultando configuração salva…</p> : !model.enabled ? <p>O assistente ainda não está habilitado para esta empresa. As telas atuais continuam disponíveis.</p> : !row ? <>
      <form className="integration-form" onSubmit={event => { event.preventDefault(); void model.create(name, transport).then(created => { if (created) onCreated?.(created.id); }); }}>
        <fieldset disabled={model.busy || model.createUncertain}><legend>Nova configuração</legend>
          <label>Nome da configuração<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>
          <label>Conexão WhatsApp<select value={transport} onChange={event => setTransport(event.target.value as 'QR' | 'META')}>
            <option value="QR">WhatsApp por QR Code</option><option value="META">WhatsApp oficial Meta</option>
          </select></label>
        </fieldset>
        <button className="button button--primary" disabled={model.busy || !name.trim()}>{model.createUncertain ? 'Consultar solicitação anterior' : 'Iniciar configuração'}</button>
      </form>
      {model.items.length > 0 && <div className="panel"><h2>Configurações salvas</h2><ul>{model.items.map(item => <li key={item.id}>
        <Link to={`/configuracao-guiada/${item.id}`}>{item.name}</Link> · {item.selection.transport} · {item.state === 'ACTIVE' ? 'Ativo' : item.state === 'CANCELLED' ? 'Cancelado' : 'Em configuração'}
      </li>)}</ul></div>}
    </> : <>
      <h2>{row.name}</h2><SetupSteps current={step} onSelect={setStep} />
      <button className="button button--secondary" disabled={model.busy} onClick={() => void model.refresh()}>Atualizar andamento</button>
      {step === 0 && <SetupDestination client={client} companyName={organizationName} disabled={disabled} />}
      {step === 1 && <SetupTransport client={client} row={row} disabled={disabled} save={model.save} />}
      {step === 2 && <SetupConnections client={client} row={row} companyName={organizationName} disabled={disabled} save={model.save} />}
      {step === 3 && <SetupRobot client={client} row={row} disabled={disabled} save={model.save} action={model.action} />}
      {step === 4 && <SetupReview client={client} row={row} busy={model.busy} action={model.action} />}
      {step < 4 && <button className="button button--primary" onClick={() => setStep(step + 1)}>Próxima etapa</button>}
    </>}
  </section>;
}
