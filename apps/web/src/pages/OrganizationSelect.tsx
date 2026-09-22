import { Navigate } from 'react-router';

import { useSession } from '../auth/SessionProvider.js';

const roleLabels = {
  OWNER: 'Proprietário',
  ADMIN: 'Administrador',
  OPERATOR: 'Operador',
  VIEWER: 'Leitor',
} as const;

export function OrganizationSelectPage() {
  const {
    status,
    selectionOrganizations,
    selectionPending,
    notice,
    selectOrganization,
  } = useSession();
  if (status === 'authenticated') return <Navigate replace to="/channels" />;
  if (status !== 'selecting') return <Navigate replace to="/login" />;

  return (
    <main className="auth-page">
      <section className="auth-card auth-card--wide" aria-labelledby="organization-title">
        <img src="/brand/logo-jrc-2024.png" alt="JRC PABX" width="112" height="75" />
        <div>
          <p className="eyebrow">Acesso autorizado</p>
          <h1 id="organization-title">Selecione a organização</h1>
          <p>Seu papel e seus dados serão limitados à organização escolhida.</p>
        </div>
        {notice ? <div className="notice notice--error" role="alert">{notice.message}</div> : null}
        <ul className="organization-list">
          {selectionOrganizations.map((organization) => (
            <li key={organization.id}>
              <div>
                <strong>{organization.name}</strong>
                <span>{roleLabels[organization.role]}</span>
              </div>
              <button
                className="button button--secondary"
                type="button"
                aria-label={`${selectionPending ? 'Acessando' : 'Acessar'} ${organization.name}`}
                disabled={selectionPending}
                onClick={() => void selectOrganization(organization.id)}
              >
                {selectionPending ? 'Acessando…' : 'Acessar'}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
