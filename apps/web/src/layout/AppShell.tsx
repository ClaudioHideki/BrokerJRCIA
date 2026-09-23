import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router';

import { useSession } from '../auth/SessionProvider.js';
import { Icon } from '../broker/Icon.js';

const navigation = [
  ['/dashboard', 'Dashboard', 'dashboard'],
  ['/channels', 'Caixas de entrada', 'connections'],
  ['/provisionamento', 'Provisionamento', 'upload'],
  ['/mensagens', 'Conversas', 'messages'],
  ['/automations', 'Automações', 'brain'],
  ['/credentials', 'Credenciais', 'key'],
  ['/uso-custos', 'Uso e custos', 'costs'],
  ['/relatorios', 'Relatórios', 'reports'],
  ['/health', 'Saúde operacional', 'health'],
  ['/brain', 'JRC Brain', 'brain'],
  ['/chaves-api', 'Chaves de API', 'key'],
  ['/integracoes', 'JRC Conversas', 'messages'],
  ['/minha-empresa', 'Configurações', 'settings'],
] as const;

const roleLabels = {
  OWNER: 'Proprietário',
  ADMIN: 'Administrador',
  OPERATOR: 'Operador',
  VIEWER: 'Leitor',
} as const;

export function AppShell() {
  const { session, switchOrganization, switchPending, logout, notice } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const firstNavigationLink = useRef<HTMLAnchorElement>(null);
  const restoreMenuFocus = useRef(false);
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= 760,
  );

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const media = window.matchMedia?.('(max-width: 760px)');
    const update = () => setMobile(media ? media.matches : window.innerWidth <= 760);
    update();
    media?.addEventListener('change', update);
    window.addEventListener('resize', update);
    return () => {
      media?.removeEventListener('change', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        restoreMenuFocus.current = true;
        setMenuOpen(false);
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [menuOpen]);

  useEffect(() => {
    if (mobile && menuOpen) firstNavigationLink.current?.focus();
  }, [menuOpen, mobile]);

  useEffect(() => {
    if (menuOpen || !restoreMenuFocus.current) return;
    restoreMenuFocus.current = false;
    menuButton.current?.focus();
  }, [menuOpen]);

  if (!session) return null;
  const navigationHidden = mobile && !menuOpen;

  return (
    <div className="console-shell">
      <aside
        className={`sidebar ${menuOpen ? 'sidebar--open' : ''}`}
        id="console-navigation"
        aria-hidden={navigationHidden || undefined}
        inert={navigationHidden}
      >
        <div className="brand-lockup">
          <img src="/brand/logo-jrc-2024.png" alt="JRC PABX" width="112" height="75" />
          <div>
            <strong>JRC Broker</strong>
            <small>WHATSAPP WORKSPACE</small>
          </div>
        </div>
        <nav aria-label="Navegação principal">
          {navigation.map(([path, label, icon], index) => (
            <NavLink
              key={path}
              ref={index === 0 ? firstNavigationLink : undefined}
              to={path}
              onClick={() => {
                restoreMenuFocus.current = mobile && menuOpen;
                setMenuOpen(false);
              }}
            >
              <Icon name={icon} />
              <span>{label}</span>
              {path === '/brain' ? <small className="nav-beta">BETA</small> : null}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="sidebar-avatar">J</span>
          <div>
            <strong>{session.activeOrganization.name}</strong>
            <small>Console operacional JRC</small>
          </div>
        </div>
      </aside>

      <div className="console-content">
        <header className="topbar">
          <button
            ref={menuButton}
            className="menu-button"
            type="button"
            aria-label={menuOpen ? 'Fechar navegação' : 'Abrir navegação'}
            aria-controls="console-navigation"
            aria-expanded={menuOpen}
            onClick={() => {
              restoreMenuFocus.current = false;
              setMenuOpen((current) => !current);
            }}
          >
            <span aria-hidden="true">☰</span>
          </button>
          <div className="organization-control">
            <label htmlFor="active-organization">Organização ativa</label>
            <select
              id="active-organization"
              aria-label="Organização ativa"
              value={session.activeOrganization.id}
              disabled={switchPending}
              onChange={(event) => void switchOrganization(event.target.value)}
            >
              {session.organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))}
            </select>
          </div>
          <span className="identity-avatar" aria-hidden="true">
            {session.user.email.slice(0, 1).toUpperCase()}
          </span>
          <div className="identity-summary">
            <span>{session.user.email}</span>
            <strong>{roleLabels[session.activeOrganization.role]}</strong>
          </div>
          <button className="button button--ghost" type="button" onClick={() => void logout()}>
            Sair
          </button>
        </header>
        <div className="session-announcer" aria-live="polite">
          Organização ativa: {session.activeOrganization.name}. Papel:{' '}
          {roleLabels[session.activeOrganization.role]}.
        </div>
        {notice ? (
          <div className="notice notice--error" role="alert">
            {notice.message}
            {notice.requestId ? <small> Solicitação: {notice.requestId}</small> : null}
          </div>
        ) : null}
        <main className="page-content">
          <Outlet key={session.activeOrganization.id} />
        </main>
      </div>
    </div>
  );
}
