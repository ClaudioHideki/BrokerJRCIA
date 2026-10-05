import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { ApiClientError } from '../api/client.js';
import type { IntegrationRequest } from '../integrations/ChatwootPanel.js';
import { roleLabels, statusLabels } from './model.js';
import './password-reset.css';

const PreviewSchema = z.object({
  userId: z.string().min(1),
  email: z.email(),
  status: z.enum(['ACTIVE', 'DISABLED']),
  confirmationToken: z.string().min(1),
  organizations: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    role: z.enum(['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER']),
    status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']),
    membershipStatus: z.enum(['ACTIVE', 'DISABLED']),
  })),
});
type Preview = z.infer<typeof PreviewSchema>;
type Props = {
  userId: string;
  request: IntegrationRequest;
  disabled: boolean;
  onClose: () => void;
  onCompleted: () => void;
};

/** Passwords live only in this mounted form and the explicit reset request. */
export function PasswordResetDialog(props: Props) {
  return <ResetForm key={props.userId} {...props} />;
}

function ResetForm({ userId, request, disabled, onClose, onCompleted }: Props) {
  const titleId = useId(), descriptionId = useId(), policyId = useId();
  const dialog = useRef<HTMLElement>(null), title = useRef<HTMLHeadingElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const api = useRef(request); api.current = request;
  const callbacks = useRef({ onClose, onCompleted }); callbacks.current = { onClose, onCompleted };
  const live = useRef(false), generation = useRef(0), pending = useRef(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [repeated, setRepeated] = useState('');
  const [busy, setBusy] = useState<'preview' | 'submit' | null>(null), [error, setError] = useState('');
  function clearFields() {
    form.current?.reset();
    setEmail(''); setPassword(''); setRepeated('');
  }
  function close() {
    generation.current++;
    clearFields(); setPreview(null);
    callbacks.current.onClose();
  }
  const closeAction = useRef(close); closeAction.current = close;

  async function inspect() {
    if (pending.current || disabled) return;
    pending.current = true;
    const version = ++generation.current;
    clearFields(); setPreview(null); setBusy('preview'); setError('');
    try {
      const value = PreviewSchema.parse(await api.current(`/users/${encodeURIComponent(userId)}/password-reset-preview`));
      if (value.userId !== userId) throw new Error('PREVIEW_IDENTITY_MISMATCH');
      if (live.current && version === generation.current) setPreview(value);
    } catch {
      if (live.current && version === generation.current) {
        setError('Não foi possível conferir a prévia global deste usuário. Consulte novamente antes de continuar.');
      }
    } finally {
      if (live.current && version === generation.current) { pending.current = false; setBusy(null); }
    }
  }

  useEffect(() => {
    live.current = true; pending.current = false;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    title.current?.focus();
    void inspect();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); closeAction.current(); return; }
      if (event.key !== 'Tab') return;
      const elements = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]');
      const first = elements?.[0], last = elements?.[elements.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !elements || !Array.from(elements).includes(active as HTMLElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (active === last || !elements || !Array.from(elements).includes(active as HTMLElement))) {
        event.preventDefault(); first.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      live.current = false; generation.current++;
      form.current?.reset();
      document.removeEventListener('keydown', handleKeyDown);
      if (previousFocus?.isConnected && !(previousFocus instanceof HTMLButtonElement && previousFocus.disabled)) previousFocus.focus();
    };
  }, []);

  const valid = preview !== null && email.trim().toLowerCase() === preview.email.toLowerCase()
    && password.length >= 12 && password.length <= 256 && password === repeated;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || disabled || !valid || !preview) return;
    pending.current = true;
    const version = ++generation.current;
    setBusy('submit'); setError('');
    const body = { password, confirmationEmail: email.trim().toLowerCase(), confirmationToken: preview.confirmationToken };
    clearFields();
    try {
      const result = await api.current(`/users/${encodeURIComponent(userId)}/password-reset`, 'POST', body);
      if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) throw new Error('INVALID_RESET_RESULT');
      if (live.current && version === generation.current) {
        setPreview(null); callbacks.current.onCompleted();
      }
    } catch (failure) {
      if (!live.current || version !== generation.current) return;
      clearFields(); setPreview(null);
      if (failure instanceof ApiClientError && ['PASSWORD_RESET_PREVIEW_CHANGED', 'PASSWORD_RESET_PREVIEW_EXPIRED'].includes(failure.code ?? '')) {
        setError('A prévia foi alterada ou está expirada. Consulte a prévia novamente e revise o usuário e todas as empresas antes de confirmar.');
      } else if (failure instanceof ApiClientError && [400, 401, 403, 404, 429].includes(failure.status)) {
        setError('Redefinição não autorizada ou dados inválidos. Confira sua sessão e permissão e consulte a prévia novamente.');
      } else {
        setError('Resultado não confirmado. A senha pode ter sido alterada. Confira o acesso do usuário antes de iniciar outra redefinição; a solicitação não será repetida automaticamente.');
      }
    } finally {
      if (live.current && version === generation.current) { pending.current = false; setBusy(null); }
    }
  }

  return <div className="dialog-backdrop" role="presentation">
    <section className="secret-dialog password-reset-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
      <p className="eyebrow">Administração global · Segurança</p>
      <h2 id={titleId} ref={title} tabIndex={-1}>Redefinir senha global</h2>
      <p id={descriptionId}>A senha é global para este usuário, em todas as empresas às quais ele está vinculado.</p>
      <p>As sessões e os acessos já autenticados serão encerrados em todas as empresas. O usuário precisará entrar novamente com a nova senha.</p>
      <p>Os vínculos, papéis e situações de acesso não serão alterados.</p>
      {busy === 'preview' && <p role="status">Consultando o usuário e todas as empresas…</p>}
      {error && <p role="alert">{error}</p>}
      {preview && <>
        <div className="password-reset-identity">
          <strong>{preview.email}</strong>
          <p>ID do usuário: {preview.userId}</p>
          <p>Situação do usuário: {preview.status === 'ACTIVE' ? 'Ativo' : 'Desativado'}</p>
        </div>
        <h3>Todos os vínculos do usuário ({preview.organizations.length})</h3>
        {preview.organizations.length ? <div className="admin-table-scroll" role="region" aria-label="Vínculos do usuário" tabIndex={0}>
          <table aria-label="Todas as empresas vinculadas ao usuário">
            <thead><tr><th>Empresa</th><th>Situação da empresa</th><th>Papel</th><th>Acesso do usuário</th></tr></thead>
            <tbody>{preview.organizations.map(company => <tr key={company.id}>
              <td>{company.name}<small className="password-reset-company-id">ID: {company.id}</small></td>
              <td>{statusLabels[company.status]}</td><td>{roleLabels[company.role]}</td>
              <td>{company.membershipStatus === 'ACTIVE' ? 'Ativo' : 'Desativado'}</td>
            </tr>)}</tbody>
          </table>
        </div> : <p>Este usuário não tem vínculos com empresas.</p>}
        <form className="admin-form" ref={form} onSubmit={event => void submit(event)} autoComplete="off">
          <label>Confirme o e-mail do usuário
            <input type="email" autoComplete="off" maxLength={254} value={email} disabled={!!busy || disabled} required onChange={event => setEmail(event.target.value)} />
          </label>
          <div className="admin-form-grid">
            <label>Nova senha
              <input type="password" autoComplete="new-password" minLength={12} maxLength={256} value={password} disabled={!!busy || disabled} required aria-describedby={policyId} onChange={event => setPassword(event.target.value)} />
            </label>
            <label>Repita a nova senha
              <input type="password" autoComplete="new-password" minLength={12} maxLength={256} value={repeated} disabled={!!busy || disabled} required onChange={event => setRepeated(event.target.value)} />
            </label>
          </div>
          <p className="admin-form-hint" id={policyId}>Use de 12 a 256 caracteres. As duas senhas devem ser iguais. A senha não será exibida após a confirmação.</p>
          <button className="button button--danger" disabled={!!busy || disabled || !valid}>Confirmar redefinição global</button>
        </form>
      </>}
      {busy === 'submit' && <p role="status">Enviando redefinição. Fechar esta janela não cancela uma solicitação já enviada.</p>}
      <div className="dialog-actions">
        {!preview && !busy && <button className="button button--secondary" disabled={disabled} onClick={() => void inspect()}>Consultar prévia novamente</button>}
        <button type="button" className="button button--ghost" onClick={close}>{busy === 'submit' ? 'Fechar' : 'Cancelar'}</button>
      </div>
    </section>
  </div>;
}
