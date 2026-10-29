import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';

import { useSession } from '../auth/SessionProvider.js';
import { Icon } from '../broker/Icon.js';
import { tenantNavigationFor, tenantPageFor } from './navigation.js';

const roleLabels = {
  OWNER: 'Proprietário',
  ADMIN: 'Administrador',
  OPERATOR: 'Operador',
  VIEWER: 'Leitor',
} as const;

export function AppShell() {
  const { session, switchOrganization, switchPending, logout, notice } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(new Set());
  const location = useLocation();
  const menuButton = useRef<HTMLButtonElement>(null);
  const firstNavigationLink = useRef<HTMLAnchorElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
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
    setQuery('');
    setCollapsedSections(new Set());
    setMenuOpen(false);
  }, [session?.activeOrganization.id]);

  useEffect(() => {
    if (mobile && menuOpen) (firstNavigationLink.current ?? searchInput.current)?.focus();
  }, [menuOpen, mobile]);

  useEffect(() => {
    if (menuOpen || !restoreMenuFocus.current) return;
    restoreMenuFocus.current = false;
    menuButton.current?.focus();
  }, [menuOpen]);

  if (!session) return null;
  const navigationHidden = mobile && !menuOpen;
  const navigation = tenantNavigationFor(session.activeOrganization.role, query);
  const groups = [...new Set(navigation.map(entry => entry.section))];
  const firstVisible = navigation.find(entry => query.trim() || !collapsedSections.has(entry.section));
  const currentPage = tenantPageFor(location.pathname, session.activeOrganization.role);

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
        <div className="navigation-search" role="search" aria-label="Páginas da empresa">
          <label htmlFor="navigation-search">Buscar páginas e configurações</label>
          <input ref={searchInput} id="navigation-search" type="search" value={query} onChange={event=>setQuery(event.target.value)} />
          {query && <button type="button" aria-label="Limpar busca de páginas" onClick={()=>{setQuery('');searchInput.current?.focus();}}>Limpar</button>}
        </div>
        <nav aria-label="Navegação principal">
          {groups.map((section, groupIndex) => {
            const expanded = Boolean(query.trim()) || !collapsedSections.has(section);
            const groupId = `navigation-group-${groupIndex}`;
            return <div className="navigation-group" key={section}>
              <button type="button" className="navigation-group-toggle" aria-label={`Seção ${section}`} aria-expanded={expanded} aria-controls={groupId}
                disabled={Boolean(query.trim())}
                onClick={()=>setCollapsedSections(current=>{
                  const next=new Set(current); if(next.has(section))next.delete(section);else next.add(section); return next;
                })}>{section}<span aria-hidden="true">{expanded?'−':'+'}</span></button>
              <div id={groupId} hidden={!expanded}>
                {navigation.filter(entry=>entry.section===section).map(entry => <NavLink key={entry.id}
                  ref={entry===firstVisible?firstNavigationLink:undefined}
                  to={entry.path} onClick={()=>{restoreMenuFocus.current=mobile&&menuOpen;setMenuOpen(false);}}>
                  <Icon name={entry.icon}/><span>{entry.label}</span>
                  {entry.id==='brain'?<small className="nav-beta">BETA</small>:null}
                </NavLink>)}
              </div>
            </div>;
          })}
          {!navigation.length && <p role="status" className="navigation-empty">Nenhuma página encontrada. Limpe a busca para ver os destinos disponíveis.</p>}
        </nav>
        <div className="sidebar-note">
          <span className="sidebar-avatar">J</span>
          <div>
            <strong>{session.activeOrganization.name}</strong>
            <small>Contexto: empresa</small>
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
          {currentPage && <nav aria-label="Caminho da página" className="page-breadcrumbs">
            <ol><li><Link to="/dashboard">Início</Link></li>
              {currentPage.section!==currentPage.label && <li><span>{currentPage.section}</span></li>}
              <li>{location.pathname.replace(/\/$/u,'')===currentPage.path
                ? <span aria-current="page">{currentPage.label}</span>
                : <><Link to={currentPage.path}>{currentPage.label}</Link><span aria-current="page"> / Detalhes</span></>}</li>
            </ol>
          </nav>}
          <Outlet key={session.activeOrganization.id} />
        </main>
      </div>
    </div>
  );
}
