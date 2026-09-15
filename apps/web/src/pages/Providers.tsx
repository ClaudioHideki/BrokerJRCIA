import { Link } from "react-router";
import { PageHeading } from "../broker/components.js";
import { Icon } from "../broker/Icon.js";

const channels = [
  {
    id: "qr",
    icon: "connections" as const,
    name: "WhatsApp Business por QR Code",
    type: "JRC · Conexão por dispositivo",
    description:
      "Cadastre uma conexão e leia o QR Code no WhatsApp Business do seu celular. Acompanhe o estado e as configurações pela JRC.",
    features: [
      "Pareamento por QR Code",
      "Configurações por conexão",
      "Histórico de operações",
    ],
    href: "/conexoes/nova",
    action: "Conectar por QR Code",
    note: "A caixa de entrada e as automações deste tipo de conexão ainda estão em desenvolvimento.",
  },
  {
    id: "official",
    icon: "globe" as const,
    name: "WhatsApp Oficial",
    type: "JRC · Integração autorizada pela Meta",
    description:
      "Autorize os ativos da sua empresa para utilizar o canal oficial do WhatsApp. Acompanhe as pendências de ativação dentro da JRC.",
    features: [
      "Autorização da empresa",
      "Templates aprovados",
      "Mensagens e automações",
    ],
    href: "/whatsapp-oficial",
    action: "Conectar WhatsApp Oficial",
    note: "A disponibilidade depende da configuração da plataforma, dos ativos autorizados e da validação da Meta.",
  },
];

export function ProvidersPage() {
  return (
    <section>
      <PageHeading
        title="Canais JRC"
        description="Escolha como conectar o WhatsApp da sua empresa."
      />
      <div className="provider-cards">
        {channels.map((channel) => (
          <article className="panel provider-card" key={channel.id}>
            <div className="provider-card-top">
              <span className="provider-mark jrc">
                <Icon name={channel.icon} />
              </span>
              <div>
                <h2>{channel.name}</h2>
                <small>{channel.type}</small>
              </div>
            </div>
            <p>{channel.description}</p>
            <ul>
              {channel.features.map((feature) => (
                <li key={feature}>
                  <Icon name="check" size={15} />
                  {feature}
                </li>
              ))}
            </ul>
            <div className="provider-card-actions">
              <Link className="button button--primary" to={channel.href}>
                {channel.action}
                <Icon name="arrow" size={16} />
              </Link>
            </div>
            <p className="workspace-help">{channel.note}</p>
          </article>
        ))}
      </div>
      <section className="panel provider-note">
        <Icon name="info" />
        <div>
          <h2>Seus canais, na sua empresa</h2>
          <p>
            As conexões e permissões pertencem à empresa selecionada. Cada
            modalidade possui seu próprio processo de ativação.
          </p>
        </div>
        <Link to="/conexoes">
          Gerenciar conexões <Icon name="arrow" size={14} />
        </Link>
      </section>
    </section>
  );
}
