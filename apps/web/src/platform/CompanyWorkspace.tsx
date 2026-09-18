import { useState, type FormEvent } from "react";
import { Metric, number } from "../broker/components.js";
import { Icon } from "../broker/Icon.js";
import { CompanyMark, Status } from "./components.js";
import { ChatwootPanel, type IntegrationRequest } from '../integrations/ChatwootPanel.js';
import {
  initialLimits,
  limitKeys,
  limitLabels,
  roleLabels,
  type Company,
  type Limits,
  type Member,
  type Monitor,
} from "./model.js";

export type DetailTab = "overview" | "plan" | "users" | "monitor" | "support" | "chatwoot";
const tabs: [DetailTab, string][] = [
  ["overview", "Visão geral"],
  ["plan", "Plano e limites"],
  ["users", "Usuários e acessos"],
  ["monitor", "Monitoramento"],
  ["support", "Suporte"],
  ["chatwoot", "JRC Conversas"],
];
const monitoring = [
  [
    "connections",
    "Instâncias conectadas e canais Meta",
    "Estado registrado na empresa",
    "connections",
    "blue",
  ],
  [
    "queue",
    "Mensagens na fila",
    "Pendentes de processamento",
    "messages",
    "purple",
  ],
  ["failures", "Falhas de mensagens", "Registros com falha", "health", "amber"],
  ["webhooks", "Eventos recebidos", "Eventos armazenados", "reports", "green"],
] as const;

export function CompanyWorkspace({
  company,
  members,
  monitor,
  loading,
  admin,
  disabled,
  defaultTab,
  saveCompany,
  saveMember,
  acknowledge,
  refresh,
  integrationRequest,
}: {
  company: Company;
  members: Member[] | null;
  monitor: Monitor | null;
  loading: boolean;
  admin: boolean;
  disabled: boolean;
  defaultTab: DetailTab;
  saveCompany: (data: FormData) => Promise<void>;
  saveMember: (data: FormData, form: HTMLFormElement) => Promise<void>;
  acknowledge: () => void;
  refresh: () => void;
  integrationRequest?: IntegrationRequest;
}) {
  const [tab, setTab] = useState(defaultTab);
  const memberList = (
    <>
      {members ? (
        members.length ? (
          <div className="admin-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Usuário</th>
                  <th>Papel</th>
                  <th>Acesso</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.userId}>
                    <td>{member.email}</td>
                    <td>{roleLabels[member.role] ?? member.role}</td>
                    <td>
                      <span
                        className={`admin-status admin-status--${member.status === "ACTIVE" ? "active" : "disabled"}`}
                      >
                        <i />
                        {member.status === "ACTIVE" ? "Ativo" : "Desativado"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>Nenhum usuário vinculado.</p>
        )
      ) : (
        <p>
          {loading
            ? "Consultando usuários…"
            : "Usuários indisponíveis. Atualize a consulta."}
        </p>
      )}
    </>
  );
  return (
    <section
      className="admin-workspace"
      aria-label={`Gestão de ${company.name}`}
    >
      <div className="panel admin-company-summary">
        <CompanyMark company={company} />
        <div>
          <h2>{company.name}</h2>
          <p>
            {company.slug} <span>·</span> Plano {company.plan}
          </p>
        </div>
        <Status status={company.status} />
        <button
          className="button button--ghost"
          disabled={disabled}
          onClick={refresh}
        >
          <Icon name="refresh" size={15} /> Atualizar dados
        </button>
      </div>
      <div className="admin-tabs" role="tablist" aria-label="Gestão da empresa">
        {tabs.map(([value, label], index) => (
          <button
            key={value}
            role="tab"
            id={`company-tab-${value}`}
            aria-controls="company-tab-panel"
            aria-selected={tab === value}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              let next = index;
              if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
              else if (event.key === "ArrowLeft")
                next = (index + tabs.length - 1) % tabs.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = tabs.length - 1;
              else return;
              event.preventDefault();
              const nextTab = tabs[next]![0];
              setTab(nextTab);
              document.getElementById(`company-tab-${nextTab}`)?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="company-tab-panel"
        aria-labelledby={`company-tab-${tab}`}
        tabIndex={0}
      >
        {tab==='chatwoot'&&integrationRequest&&<ChatwootPanel key={company.id} request={integrationRequest} canManage={admin} platform disabled={disabled} companyName={company.name} ownerEmail={members?.find(m=>m.role==='OWNER')?.email??''}/>}
        {(tab === "overview" || tab === "monitor" || tab === "support") && (
          <>
            {monitor ? (
              <div className="metric-grid metric-grid--four">
                {monitoring.map(([key, label, note, icon, tone]) => (
                  <Metric
                    key={key}
                    label={label}
                    value={number(monitor[key])}
                    note={note}
                    icon={icon}
                    tone={tone}
                  />
                ))}
              </div>
            ) : (
              <div className="panel admin-empty" role="status">
                {loading
                  ? "Consultando indicadores…"
                  : "Indicadores indisponíveis. Atualize a consulta."}
              </div>
            )}
            {tab === "monitor" && (
              <div className="panel">
                <h2>Leitura dos indicadores</h2>
                <p>
                  A contagem de conexões reúne instâncias conectadas e canais
                  oficiais cadastrados. Os demais indicadores refletem os
                  registros armazenados para esta empresa.
                </p>
                <p>Atualize os dados para consultar a operação novamente.</p>
              </div>
            )}
          </>
        )}
        {tab === "overview" && (
          <div className="admin-detail-columns">
            <section className="panel">
              <div className="admin-panel-heading">
                <h2>Responsáveis e usuários</h2>
                <button
                  className="admin-text-link"
                  onClick={() => setTab("users")}
                >
                  Gerenciar <Icon name="arrow" size={15} />
                </button>
              </div>
              {memberList}
            </section>
            <section className="panel">
              <h2>Capacidade do plano</h2>
              <dl className="admin-limits-list">
                {limitKeys.map((key) => (
                  <div key={key}>
                    <dt>{limitLabels[key]}</dt>
                    <dd>
                      {company.limits
                        ? number(company.limits[key])
                        : "Não informado"}
                    </dd>
                  </div>
                ))}
              </dl>
              <button
                className="button button--secondary"
                onClick={() => setTab("plan")}
              >
                Ver plano e limites
              </button>
            </section>
          </div>
        )}
        {tab === "plan" && (
          <section className="panel">
            <div className="admin-panel-heading">
              <div>
                <h2>Plano e disponibilidade</h2>
                <p>
                  Defina a situação da empresa e sua capacidade de operação.
                </p>
              </div>
              <Icon name="settings" />
            </div>
            {admin ? (
              <form
                className="admin-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveCompany(new FormData(event.currentTarget));
                }}
              >
                <div className="admin-form-grid">
                  <label>
                    Situação
                    <select name="status" defaultValue={company.status}>
                      <option value="ACTIVE">Ativa</option>
                      <option value="SUSPENDED">Suspensa</option>
                      <option value="DISABLED">Desativada</option>
                    </select>
                  </label>
                  <label>
                    Plano
                    <input
                      name="plan"
                      defaultValue={company.plan}
                      required
                      maxLength={80}
                    />
                  </label>
                </div>
                <p className="admin-form-hint">
                  Suspender bloqueia novos envios e pausa pendências. Dados e
                  eventos recebidos são preservados.
                </p>
                <fieldset>
                  <legend>Módulos da empresa</legend>
                  <input type="hidden" name="flowsConfigPresent" value="1" />
                  <label><input type="checkbox" name="flowsEnabled" defaultChecked={company.flowsEnabled === true} /> Liberar JRC Flows</label>
                  <p className="admin-form-hint">Habilita o canvas e os chatbots desta empresa. Desativar bloqueia novas execuções e envios pendentes dos flows.</p>
                </fieldset>
                <fieldset>
                  <legend>Limites da empresa</legend>
                  <div className="admin-form-grid">
                    {limitKeys.map((key) => (
                      <label key={key}>
                        {limitLabels[key]}
                        <input
                          name={key}
                          type="number"
                          min={1}
                          max={100000000}
                          step={1}
                          defaultValue={company.limits?.[key]}
                          required={!!company.limits}
                          placeholder="Manter atual"
                        />
                      </label>
                    ))}
                  </div>
                  {!company.limits && (
                    <small>
                      Para alterar os limites, preencha os quatro valores.
                    </small>
                  )}
                </fieldset>
                <div className="admin-form-actions">
                  <button
                    className="button button--primary"
                    disabled={disabled}
                  >
                    Salvar situação e plano
                  </button>
                </div>
              </form>
            ) : (
              <dl className="admin-limits-list">
                {limitKeys.map((key) => (
                  <div key={key}>
                    <dt>{limitLabels[key]}</dt>
                    <dd>
                      {company.limits
                        ? number(company.limits[key])
                        : "Não informado"}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
        )}
        {tab === "users" && (
          <>
            <section className="panel">
              <div className="admin-panel-heading">
                <div>
                  <h2>Usuários da empresa</h2>
                  <p>Os papéis e acessos abaixo pertencem a {company.name}.</p>
                </div>
                <Icon name="key" />
              </div>
              {memberList}
            </section>
            {admin && (
              <section className="panel">
                <h2>Adicionar ou atualizar acesso</h2>
                <p>
                  Para um usuário existente, informe o e-mail e ajuste o papel
                  ou a situação.
                </p>
                <form
                  className="admin-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveMember(
                      new FormData(event.currentTarget),
                      event.currentTarget,
                    );
                  }}
                >
                  <div className="admin-form-grid">
                    <label>
                      E-mail do usuário
                      <input
                        type="email"
                        name="email"
                        maxLength={254}
                        autoComplete="off"
                        required
                      />
                    </label>
                    <label>
                      Senha inicial (somente novo usuário)
                      <input
                        type="password"
                        name="password"
                        autoComplete="new-password"
                        minLength={12}
                        maxLength={256}
                      />
                    </label>
                    <label>
                      Papel na empresa
                      <select name="role">
                        <option value="VIEWER">Leitor</option>
                        <option value="OPERATOR">Operador</option>
                        <option value="ADMIN">Administrador da empresa</option>
                        <option value="OWNER">Responsável</option>
                      </select>
                    </label>
                    <label>
                      Acesso
                      <select name="status">
                        <option value="ACTIVE">Ativo</option>
                        <option value="DISABLED">Desativado</option>
                      </select>
                    </label>
                  </div>
                  <div className="admin-form-actions">
                    <button
                      className="button button--primary"
                      disabled={disabled}
                    >
                      Salvar acesso
                    </button>
                  </div>
                </form>
              </section>
            )}
          </>
        )}
        {tab === "support" && (
          <section className="panel admin-support-card">
            <span className="admin-feature-icon">
              <Icon name="messages" size={28} />
            </span>
            <div>
              <h2>Atendimento à empresa</h2>
              <p>
                Registre o atendimento de {company.name}. O motivo informado no
                contexto abaixo acompanhará o registro de auditoria.
              </p>
              <button
                className="button button--primary"
                disabled={disabled}
                onClick={acknowledge}
              >
                Registrar atendimento de suporte
              </button>
            </div>
          </section>
        )}
      </div>
    </section>
  );
}

export function NewCompany({
  disabled,
  cancel,
  submit,
}: {
  disabled: boolean;
  cancel: () => void;
  submit: (data: FormData, limits: Limits) => Promise<void>;
}) {
  const [limits, setLimits] = useState(initialLimits);
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit(new FormData(event.currentTarget), limits);
  }
  return (
    <section className="panel admin-new-company">
      <div className="admin-panel-heading">
        <div>
          <h2>Nova empresa</h2>
          <p>Crie o cliente, o acesso do responsável e os limites iniciais.</p>
        </div>
        <Icon name="providers" size={24} />
      </div>
      <form className="admin-form" onSubmit={save}>
        <fieldset>
          <legend>Dados da empresa</legend>
          <div className="admin-form-grid">
            <label>
              Nome da empresa
              <input name="name" required maxLength={120} autoFocus />
            </label>
            <label>
              Identificador
              <input
                name="slug"
                required
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                maxLength={80}
                placeholder="ex.: minha-empresa"
              />
            </label>
            <label>
              E-mail do responsável
              <input
                name="ownerEmail"
                type="email"
                maxLength={254}
                required
                autoComplete="off"
              />
            </label>
            <label>
              Senha inicial do responsável
              <input
                name="ownerPassword"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={256}
                required
              />
            </label>
          </div>
        </fieldset>
        <fieldset>
          <legend>Plano e capacidade</legend>
          <label><input type="checkbox" name="flowsEnabled" /> Liberar JRC Flows para esta empresa</label>
          <div className="admin-form-grid">
            <label>
              Plano
              <input
                name="plan"
                required
                maxLength={80}
                defaultValue="Inicial"
              />
            </label>
            {limitKeys.map((key) => (
              <label key={key}>
                {limitLabels[key]}
                <input
                  type="number"
                  min={1}
                  max={100000000}
                  step={1}
                  value={limits[key]}
                  onChange={(event) =>
                    setLimits({ ...limits, [key]: Number(event.target.value) })
                  }
                  required
                />
              </label>
            ))}
          </div>
        </fieldset>
        <div className="admin-form-actions">
          <button
            className="button button--secondary"
            type="button"
            disabled={disabled}
            onClick={cancel}
          >
            Cancelar
          </button>
          <button className="button button--primary" disabled={disabled}>
            Salvar empresa
          </button>
        </div>
      </form>
    </section>
  );
}
