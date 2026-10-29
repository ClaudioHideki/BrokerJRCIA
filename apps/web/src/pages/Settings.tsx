import { useLayoutEffect, useState } from 'react';
import { Link } from 'react-router';
import { useSession } from '../auth/SessionProvider.js';
import { Icon } from '../broker/Icon.js';
import { PageHeading } from '../broker/components.js';
import { tenantNavigationFor, type TenantRole } from '../layout/navigation.js';

const roleLabels: Record<TenantRole, string> = {
  OWNER: 'Proprietário', ADMIN: 'Administrador', OPERATOR: 'Operador', VIEWER: 'Leitor',
};
export function SettingsPage() {
  const { session, tenantRevision } = useSession();
  const [query, setQuery] = useState('');
  const organization = session?.activeOrganization;
  useLayoutEffect(() => { setQuery(''); }, [organization?.id, tenantRevision]);
  if (!organization) return null;
  const entries = tenantNavigationFor(organization.role, query).filter((entry) =>
    entry.path !== '/configuracoes' && entry.availability === 'available',
  );

  return <section className="settings-page">
    <PageHeading title="Configurações" description="Encontre as páginas e configurações disponíveis para seu acesso na empresa atual." />
    <dl className="platform-metrics">
      <div><dt>Empresa selecionada</dt><dd>{organization.name}</dd></div>
      <div><dt>Seu papel nesta empresa</dt><dd>{roleLabels[organization.role]}</dd></div>
    </dl>
    <section className="panel" aria-labelledby="settings-scope-title">
      <h2 id="settings-scope-title">Onde cada configuração é aplicada</h2>
      <p><strong>Empresa:</strong> limites, chaves de API e credenciais pertencem à empresa selecionada. Cada página permite as ações autorizadas pelo seu papel.</p>
      <p><strong>Conexão e caixa de entrada:</strong> selecione o canal para configurar o WhatsApp, o destino de atendimento e o Flow. Os estados de conexão e de atendimento são distintos.</p>
      <p><strong>Integração:</strong> conta, destino autorizado e vínculos são consultados na página de integrações.</p>
      <p><strong>Plataforma e deployment:</strong> configurações globais e parâmetros de implantação são administrados pela equipe JRC no contexto próprio. Alterações que exigem reinício devem ser aplicadas e verificadas no servidor.</p>
    </section>
    <div className="form-grid settings-search">
      <label htmlFor="settings-search">Buscar páginas e configurações</label>
      <input id="settings-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ex.: conexão, credenciais, integração" />
    </div>
    <h2>Páginas disponíveis</h2>
    {entries.length ? <ul className="connection-grid settings-grid">
      {entries.map((entry) => <li className="panel" key={entry.id}>
        <span className="eyebrow">{entry.section}</span>
        <h3><Icon name={entry.icon} />{' '}{entry.external
          ? <a href={entry.path} aria-label={entry.label}>{entry.label}</a>
          : <Link to={entry.path} aria-label={entry.label}>{entry.label}</Link>}</h3>
        <p>{entry.description}</p>
      </li>)}
    </ul> : <p className="notice" role="status">Nenhuma página encontrada. Tente outro termo de busca.</p>}
  </section>;
}
