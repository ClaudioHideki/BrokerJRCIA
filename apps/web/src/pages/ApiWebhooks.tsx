import { Link } from 'react-router';
import { useSession } from '../auth/SessionProvider.js';
import { PageHeading } from '../broker/components.js';

export function ApiWebhooksPage() {
  const { session } = useSession();
  if (!session) return null;
  const organization = session.activeOrganization;
  const canManageKeys = organization.role === 'OWNER' || organization.role === 'ADMIN';
  return <section className="api-webhooks-page">
    <PageHeading title="API e webhooks" description="Escolha o modo de integração e consulte os contratos públicos da API JRC." />
    <p>Empresa selecionada: <strong>{organization.name}</strong>. Credenciais e recursos devem pertencer a esta empresa.</p>
    <div className="connection-grid">
      <section className="panel">
        <h2>Modo A — API de parceiro</h2>
        <p>O backend do parceiro, como CCLX ou JRC Conversas, guarda a chave de serviço e chama a API JRC com os scopes autorizados. A emissão da chave não exige URL, Account ID ou token administrativo do Chatwoot.</p>
        <p>A chave de API não cria automaticamente uma caixa no sistema parceiro. O backend do host deve criar ou selecionar a caixa, persistir o vínculo e projetar as mensagens e seus estados.</p>
        <p>Para receber eventos, configure um callback HTTPS autorizado ou implemente o polling por cursor previsto no contrato. Uma chave sem consumidor não entrega eventos ao host.</p>
        <p>QR e Flow embarcados exigem BFF, sessão e permissões reais do host. Guarde a chave somente no servidor; nunca no widget, bundle, URL ou armazenamento do navegador.</p>
      </section>
      <section className="panel">
        <h2>Modo B — integração direta</h2>
        <p>O Broker usa a origem HTTPS aprovada, conta, credencial remota e vínculos explícitos das caixas do JRC Conversas ou Chatwoot. Esses dados são necessários para o Broker operar a integração remota.</p>
        <p>Reutilize o onboarding, adoção e controle existentes. Confira em cada etapa qual sistema cria ou reutiliza a caixa e as pendências de configuração.</p>
        <p>Defina um responsável pelo envio e um pela projeção de mensagens em cada caixa. A escolha de modo não migra vínculos existentes nem autoriza dois caminhos de envio simultâneos.</p>
        <Link className="button button--secondary" to="/integracoes">Configurar integração direta</Link>
      </section>
    </div>
    <section className="panel" aria-labelledby="api-credentials-title">
      <h2 id="api-credentials-title">Credenciais e eventos</h2>
      <p>A chave identifica a empresa e limita as operações pelos scopes concedidos. Use validade, rotação e revogação conforme o contrato. O segredo de assinatura dos eventos é separado da chave de API.</p>
      <p>Revogar uma chave não revoga automaticamente os endpoints de webhook. Consulte assinatura, timestamp, deduplicação por eventId, retry e reconciliação antes de habilitar o consumidor.</p>
      {canManageKeys ? <Link className="button button--primary" to="/chaves-api">Gerenciar chaves de API</Link>
        : <p>Um proprietário ou administrador da empresa pode emitir e gerenciar a chave de API. A documentação permanece disponível para consulta.</p>}
    </section>
    <section className="panel" aria-labelledby="api-public-profile-title">
      <h2 id="api-public-profile-title">Cobertura atual do perfil de parceiro</h2>
      <p>O perfil público de mensageria documenta texto individual por WhatsApp QR e consulta de mensagens, incluindo download privado de anexos. Aceitação em fila não confirma entrega: acompanhe os estados e eventos.</p>
      <p>Envio de mídia, grupos, templates Meta e gestão de Flows ainda exigem ampliação explícita do contrato público e de sua autorização. A existência dessas funções em outras áreas do Broker não as habilita nesta credencial.</p>
      <p>Um resultado incerto exige reconciliação antes de novo envio. A documentação identifica limites e diferenças entre os perfis; não use endpoints internos ou de plataforma como API de parceiro.</p>
    </section>
    <section className="panel" aria-labelledby="api-documents-title">
      <h2 id="api-documents-title">Documentação e contratos</h2>
      <p>Consulte a base URL do ambiente, os exemplos, scopes, erros e limites no portal. Os testes com efeito real exigem uma ação deliberada e um destino de laboratório autorizado.</p>
      <p><a className="button button--primary" href="/documentation/">Abrir documentação da API</a></p>
      <ul>
        <li><a href="/documentation/guia-api-jrc.pdf">Guia da API em PDF</a></li>
        <li><a href="/documentation/openapi-instances.json">OpenAPI de conexões</a></li>
        <li><a href="/documentation/openapi-messaging.json">OpenAPI de mensagens</a></li>
        <li><a href="/documentation/openapi-events.json">OpenAPI de eventos</a></li>
        <li><a href="/documentation/openapi-chatwoot.json">OpenAPI de integração direta</a></li>
        <li><a href="/documentation/postman-messaging.json">Postman de mensagens</a></li>
        <li><a href="/documentation/postman-events.json">Postman de eventos</a></li>
      </ul>
      <p>O portal recebe credenciais somente em memória e mantém as operações de escrita sob escolha explícita. Esta página não recebe nem armazena segredos.</p>
    </section>
  </section>;
}
