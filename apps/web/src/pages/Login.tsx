import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router';

import { useSession } from '../auth/SessionProvider.js';

export function LoginPage() {
  const { status, notice, login } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (status === 'authenticated') return <Navigate replace to="/conexoes" />;
  if (status === 'selecting') return <Navigate replace to="/selecionar-organizacao" />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await login({ email, password });
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="login-title">
        <img src="/brand/logo-jrc-2024.png" alt="JRC PABX" width="131" height="88" />
        <div>
          <p className="eyebrow">JRC WhatsApp Broker</p>
          <h1 id="login-title">Acesse sua console</h1>
          <p>Gerencie conexões e credenciais da sua organização.</p>
        </div>
        {notice ? (
          <div className="notice notice--error" role="alert">
            {notice.message}
            {notice.requestId ? <small> Solicitação: {notice.requestId}</small> : null}
          </div>
        ) : null}
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="email">E-mail</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <label htmlFor="password">Senha</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button className="button button--primary" type="submit" disabled={submitting || status === 'booting'}>
            {submitting ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
        <p>Este acesso é para usuários das empresas clientes.</p>
        <Link to="/jrc">Acessar administração JRC</Link>
      </section>
    </main>
  );
}
