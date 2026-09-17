import { useState } from 'react';
import type { ChatwootStatus } from '@jrc/contracts';

export function ChatwootDestinationPanel({ data, platform, canManage, blocked, action }: {
  data: ChatwootStatus; platform: boolean; canManage: boolean; blocked: boolean;
  action: (path: string, method: string, body: unknown, success: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<'MANAGED' | 'EXTERNAL'>(data.destination?.mode ?? (data.managedBaseUrl ? 'MANAGED' : 'EXTERNAL'));
  const [url, setUrl] = useState(data.destination?.baseUrl ?? '');
  const destination = data.destination;
  return <section className="panel integration-account">
    <div><h3>Instalação de atendimento</h3>
      <p>{destination?.baseUrl ?? 'Escolha onde sua equipe atenderá as conversas.'}</p>
      {destination?.approvalStatus === 'PENDING' && <p>Aguardando aprovação da equipe JRC. O token será solicitado após a aprovação.</p>}
      {destination?.approvalStatus === 'REVOKED' && <p>Autorização revogada. Solicite uma revisão à equipe JRC.</p>}
      {destination?.approvalStatus === 'APPROVED' && <p>Destino autorizado. A compatibilidade e a entrega ainda precisam ser verificadas.</p>}
    </div>
    {canManage && !platform && !data.connections.length && <form className="integration-form" onSubmit={e => {
      e.preventDefault();
      void action('/destination', 'PUT', { mode, baseUrl: mode === 'MANAGED' ? data.managedBaseUrl : url }, 'Destino solicitado para aprovação.');
    }}>
      <label>Instalação de atendimento<select value={mode} onChange={e => setMode(e.target.value as typeof mode)} disabled={blocked}>
        {data.managedBaseUrl && <option value="MANAGED">JRC Conversas gerenciado</option>}
        <option value="EXTERNAL">Meu Chatwoot</option>
      </select></label>
      {mode === 'EXTERNAL' && <label>Endereço do Chatwoot<input type="url" value={url} required disabled={blocked} onChange={e => setUrl(e.target.value)} placeholder="https://atendimento.suaempresa.com.br" /></label>}
      <button className="button" disabled={blocked}>Solicitar destino</button>
    </form>}
    {platform && canManage && destination && destination.approvalStatus !== 'APPROVED' && <form className="integration-form" onSubmit={e => {
      e.preventDefault();
      const form = new FormData(e.currentTarget);
      void action('/destination/approve', 'POST', { revision: destination.revision,
        mediaOrigins: String(form.get('mediaOrigins') ?? '').split(/[\n,]/).map(x => x.trim()).filter(Boolean) }, 'Destino aprovado.');
    }}>
      <p>Revise o endereço acima e os domínios de anexos antes de autorizar esta empresa.</p>
      <label>Domínios de anexos autorizados<textarea name="mediaOrigins" placeholder="https://arquivos.suaempresa.com.br" disabled={blocked} /></label>
      <button className="button" disabled={blocked}>Aprovar destino revisado</button>
    </form>}
  </section>;
}
