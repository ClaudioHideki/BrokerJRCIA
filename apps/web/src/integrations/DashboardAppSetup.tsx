import { useEffect, useRef, useState } from 'react';
import { EmbedAppSchema, EmbedAppSetupSchema } from '@jrc/contracts';
import type { IntegrationRequest } from './ChatwootPanel.js';
export function DashboardAppSetup({ request }: { request: IntegrationRequest }) {
  const [setup, setSetup] = useState<ReturnType<typeof EmbedAppSetupSchema.parse> | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const live = useRef(true), running = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  async function run(install: boolean) {
    if (running.current) return; running.current = true; setBusy(true); setError('');
    try {
      const id = setup?.embedId ?? EmbedAppSchema.parse(await request('/embed-apps', 'POST', {})).embedId;
      if (!live.current) return;
      const value = install ? await request(`/embed-apps/${id}/install`, 'POST', {}) : await request(`/embed-apps/${id}`);
      if (live.current) setSetup(EmbedAppSetupSchema.parse(value));
    } catch { if (live.current) setError('Painel indisponível. Confira a ativação e as permissões com a equipe JRC. O portal continua disponível.'); }
    finally { running.current = false; if (live.current) setBusy(false); }
  }
  return <section className="panel"><h3>Painel opcional no Chatwoot</h3>
    <p>Consulte e reconecte caixas durante o atendimento. A autorização usa seu login JRC e dura cinco minutos.</p>
    <button className="button button--secondary" disabled={busy} onClick={() => void run(false)}>Preparar painel do Chatwoot</button>
    {error && <p role="alert">{error}</p>}
    {setup && <div className="form-stack">
      <label>Nome do aplicativo<input readOnly value={setup.title} /></label>
      <label>URL do aplicativo<input readOnly value={setup.url} /></label>
      <button className="button button--primary" disabled={busy} onClick={() => void run(true)}>Instalar ou conferir aplicativo</button>
      {setup.state === 'INSTALLED' && <p role="status">Aplicativo conferido na conta. Abra uma conversa no Chatwoot para acessá-lo.</p>}
      {setup.state === 'MANUAL' && <p role="status">Cadastro automático indisponível nesta instalação. Se ela oferece Dashboard Apps, cadastre o nome e a URL acima como administrador.</p>}
      {setup.state === 'UNKNOWN' && <p role="status">Resultado não confirmado. Confira os aplicativos no Chatwoot e use este botão para reconciliar pela URL. A criação não será repetida automaticamente.</p>}
    </div>}
    <p>O aplicativo não adiciona botões ao assistente de novas caixas do Chatwoot.</p>
    <a href="/conexoes">Operar pelo portal JRC</a>
  </section>;
}
