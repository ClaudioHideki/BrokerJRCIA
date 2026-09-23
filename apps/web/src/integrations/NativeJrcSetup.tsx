import { useEffect, useRef, useState } from 'react';
import { IssuedControlCredentialSchema } from '@jrc/contracts';
import type { IntegrationRequest } from './ChatwootPanel.js';

export function NativeJrcSetup({ request, accountId, baseUrl }: {
  request: IntegrationRequest; accountId: number; baseUrl: string;
}) {
  const [issued, setIssued] = useState<ReturnType<typeof IssuedControlCredentialSchema.parse> | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const intent = useRef<string | null>(null), live = useRef(false), pending = useRef(false), generation = useRef(0);
  useEffect(() => {
    live.current = true;
    const clear = () => { generation.current++; setIssued(null); };
    window.addEventListener('pagehide', clear);
    return () => { live.current = false; generation.current++; window.removeEventListener('pagehide', clear); };
  }, []);
  async function issue() {
    if (pending.current || issued) return;
    pending.current = true; setBusy(true); setError('');
    intent.current ??= crypto.randomUUID();
    const revision = generation.current;
    try {
      const value = IssuedControlCredentialSchema.parse(await request('/control-credentials', 'POST', {
        name: `Módulo JRC Conversas — conta ${accountId}`,
        scopes: ['chatwoot:read', 'chatwoot:manage', 'chatwoot:pair', 'chatwoot:disconnect'], expiresAt: null,
      }, { idempotencyKey: intent.current }));
      if (value.binding.accountId !== accountId) throw new Error('ACCOUNT_MISMATCH');
      if (live.current && revision === generation.current) setIssued(value);
    } catch {
      if (live.current && revision === generation.current) setError('Não foi possível confirmar a emissão. Repita a consulta. Se a chave já foi emitida e não apareceu, revogue-a em Chaves de API antes de iniciar uma nova emissão.');
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }
  const accountUrl = `${baseUrl.replace(/\/$/, '')}/app/accounts/${accountId}`;
  return <section className="panel form-stack">
    <h3>Módulo nativo JRC Conversas</h3>
    <p>O módulo dentro do sistema de atendimento precisa ser instalado separadamente. Emitir uma chave não instala botões ou telas no JRC Conversas ou no Chatwoot.</p>
    <ol><li>Para usar agora, conecte o WhatsApp em Caixas de entrada e vincule a caixa API pela seção abaixo.</li><li>Para uma experiência dentro da central, a equipe técnica deve instalar o conector JRC no servidor da central, com o endereço HTTPS do Broker, o ID da empresa e uma chave restrita à conta.</li><li>O conector valida o usuário e a caixa antes de exibir o QR temporário. O módulo Automações usa os fluxos publicados no Broker.</li></ol>
    <p>A chave permite controlar somente a conta {accountId}. Guarde-a no servidor do JRC Conversas; os agentes não precisam recebê-la. A chave completa aparece apenas nesta emissão.</p>
    {error && <p role="alert">{error} <a href="/chaves-api">Abrir Chaves de API</a></p>}
    {!issued && <button className="button button--primary" disabled={busy} onClick={() => void issue()}>{error ? 'Repetir consulta da emissão' : 'Emitir chave para o módulo JRC'}</button>}
    {issued && <>
      <label>ID da empresa no Broker<input readOnly value={issued.binding.organizationId} /></label>
      <label>Chave de controle da conta<input readOnly type="password" autoComplete="off" value={issued.secret} onFocus={event => event.currentTarget.select()} /></label>
      <button className="button button--secondary" onClick={() => {
        void navigator.clipboard.writeText(issued.secret).then(() => { if (live.current) setCopied(true); }).catch(() => { if (live.current) setError('Não foi possível copiar. Permita a área de transferência neste navegador.'); });
      }}>Copiar chave</button>
      {copied && <p role="status">Chave copiada. Cole somente no campo protegido do módulo JRC.</p>}
      <button className="button button--secondary" onClick={() => { setIssued(null); setCopied(false); intent.current = null; }}>Fechar e apagar chave desta tela</button>
    </>}
    <p><a href={accountUrl} target="_blank" rel="noopener noreferrer">Abrir central de atendimento</a></p><p><a href="/channels">Conectar WhatsApp no Broker</a> · <a href="/automations">Criar automação no Broker</a></p>
  </section>;
}
