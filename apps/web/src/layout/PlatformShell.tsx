import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { NavLink } from "react-router";
import { Icon } from "../broker/Icon.js";
import type { StaffSession } from "../platform/model.js";
import { platformNavigationFor } from './navigation.js';

export function PlatformShell({
  session,
  busy,
  logout,
  children,
}: {
  session: StaffSession;
  busy: boolean;
  logout: () => void;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [groupCollapsed, setGroupCollapsed] = useState(false);
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 760);
  const trigger = useRef<HTMLButtonElement>(null);
  const firstLink = useRef<HTMLAnchorElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const navigation = platformNavigationFor(query);
  const groupExpanded = Boolean(query.trim()) || !groupCollapsed;
  useLayoutEffect(() => {
    setQuery('');
    setGroupCollapsed(false);
    setMenuOpen(false);
  }, [session.user.id]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia?.("(max-width: 760px)");
    const update = () =>
      setMobile(media ? media.matches : window.innerWidth <= 760);
    update();
    media?.addEventListener("change", update);
    window.addEventListener("resize", update);
    return () => {
      media?.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  useEffect(() => {
    if (!menuOpen || !mobile) return;
    (firstLink.current ?? searchInput.current)?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [menuOpen, mobile]);
  function closeMenu() {
    setMenuOpen(false);
    if (mobile) trigger.current?.focus();
  }
  const hidden = mobile && !menuOpen;
  return (
    <div className="console-shell admin-console">
      <aside
        className={`sidebar ${menuOpen ? "sidebar--open" : ""}`}
        id="admin-navigation"
        aria-hidden={hidden || undefined}
        inert={hidden}
      >
        <div className="brand-lockup">
          <img
            src="/brand/logo-jrc-2024.png"
            alt="JRC"
            width="38"
            height="33"
          />
          <div>
            <strong>JRC Broker</strong>
            <small>ADMINISTRAÇÃO</small>
          </div>
        </div>
        <div className="admin-nav-label">GESTÃO DA PLATAFORMA</div>
        <div className="navigation-search" role="search" aria-label="Páginas da plataforma">
          <label htmlFor="platform-navigation-search">Buscar páginas da plataforma</label>
          <input ref={searchInput} id="platform-navigation-search" type="search" value={query}
            onChange={(event) => setQuery(event.target.value)} />
          {query && <button type="button" aria-label="Limpar busca da plataforma" onClick={() => {
            setQuery('');
            searchInput.current?.focus();
          }}>Limpar</button>}
        </div>
        <nav aria-label="Administração JRC">
          {navigation.length ? <div className="navigation-group">
            <button type="button" className="navigation-group-toggle" aria-expanded={groupExpanded}
              aria-controls="platform-navigation-group" disabled={Boolean(query.trim())}
              onClick={() => setGroupCollapsed((current) => !current)}>Plataforma<span aria-hidden="true">{groupExpanded ? '−' : '+'}</span></button>
            <div id="platform-navigation-group" hidden={!groupExpanded}>
          {navigation.map((section, index) => (
            <NavLink
              key={section.path}
              to={section.path}
              end
              ref={index === 0 && groupExpanded ? firstLink : undefined}
              onClick={closeMenu}
            >
              <Icon name={section.icon} />
              <span>{section.label}</span>
            </NavLink>
          ))}
            </div>
          </div> : <p role="status" className="navigation-empty">Nenhuma página encontrada. Limpe a busca para ver os destinos disponíveis.</p>}
        </nav>
        <div className="admin-sidebar-info">
          <Icon name="globe" size={24} />
          <strong>Uma marca. Todos os canais.</strong>
          <p>WhatsApp por QR Code e WhatsApp Oficial, com a identidade JRC.</p>
        </div>
        <div className="sidebar-note">
          <span className="sidebar-avatar">J</span>
          <div>
            <strong>Equipe JRC</strong>
            <small>Contexto: plataforma</small>
          </div>
        </div>
      </aside>
      {mobile && menuOpen && (
        <button
          className="admin-menu-backdrop"
          aria-label="Fechar menu lateral"
          onClick={closeMenu}
        />
      )}
      <div className="console-content">
        <header className="topbar">
          <button
            ref={trigger}
            className="menu-button"
            aria-label={menuOpen ? "Fechar navegação" : "Abrir navegação"}
            aria-controls="admin-navigation"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            ☰
          </button>
          <div className="admin-topbar-context">
            <span>Console JRC</span>
            <strong>Administração da plataforma</strong>
          </div>
          <span className="identity-avatar" aria-hidden="true">
            {session.user.email.slice(0, 1).toUpperCase()}
          </span>
          <div className="identity-summary">
            <span>{session.user.email}</span>
            <strong>
              {session.user.role === "SUPER_ADMIN"
                ? "Administrador global"
                : "Equipe de suporte"}
            </strong>
          </div>
          <button
            className="button button--ghost"
            disabled={busy}
            onClick={logout}
            aria-label="Sair da administração"
          >
            Sair
          </button>
        </header>
        <main className="page-content">{children}</main>
      </div>
    </div>
  );
}
