import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Icon } from "../broker/Icon.js";
import { ApiClientError } from '../api/client.js';
import { PlatformShell } from "../layout/PlatformShell.js";
import { EconomicGroups } from '../platform/EconomicGroups.js';
import {
  AdminCharts,
  AdminMetrics,
  CompanyTable,
} from "../platform/components.js";
import {
  CompanyWorkspace,
  NewCompany,
  type DetailTab,
} from "../platform/CompanyWorkspace.js";
import {
  limitKeys,
  sections,
  type Company,
  type Limits,
  type Member,
  type Monitor,
  type StaffSession,
} from "../platform/model.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function platformErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Não foi possível concluir. Tente novamente.";
  if (error instanceof ApiClientError && error.status >= 500) {
    const reference = error.correlationId ?? error.requestId;
    return reference ? `${error.message} Referência: ${reference}` : error.message;
  }
  if(error instanceof ApiClientError&&error.code==='PLATFORM_LAST_OWNER')return 'Cadastre outro responsável ativo antes de remover este acesso.';
  return error.message;
}

export function PlatformPage() {
  const [session, setSession] = useState<StaffSession | null>(null);
  const [mfaRequired, setMfaRequired] = useState(true);
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reason, setReason] = useState("Consulta operacional da plataforma");
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companiesLoaded, setCompaniesLoaded] = useState(false);
  const [companiesLoading, setCompaniesLoading] = useState(false);
  const [selected, setSelected] = useState<Company | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [monitor, setMonitor] = useState<Monitor | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [creating, setCreating] = useState(false);
  const generation = useRef(0);
  const inspection = useRef(0);
  const listVersion = useRef(0);
  const location = useLocation();
  const navigate = useNavigate();
  const section =
    sections.find(
      (item) => item.path === location.pathname.replace(/\/$/, ""),
    ) ?? sections[0];
  const dashboard = section.path === "/jrc";
  const admin = session?.user.role === "SUPER_ADMIN";
  const disabled = busy || reason.trim().length < 5;
  const defaultTab: DetailTab = section.path.endsWith("/usuarios")
    ? "users"
    : section.path.endsWith("/planos")
      ? "plan"
      : section.path.endsWith("/monitoramento")
        ? "monitor"
        : section.path.endsWith("/suporte")
          ? "support"
          : "overview";

  function clearSession() {
    generation.current++;
    inspection.current++;
    listVersion.current++;
    setSession(null);
    setCompanies([]);
    setCompaniesLoaded(false);
    setCompaniesLoading(false);
    setSelected(null);
    setMembers(null);
    setMonitor(null);
    setCreating(false);
    setInspecting(false);
    setBusy(false);
    setNotice("");
    setReason("Consulta operacional da plataforma");
  }
  useEffect(
    () => () => {
      generation.current++;
      inspection.current++;
      listVersion.current++;
    },
    [],
  );
  useEffect(() => {
    setCreating(false);
  }, [location.pathname]);

  async function request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    active = session,
  ): Promise<T> {
    const current = generation.current;
    const response = await fetch("/v1/platform" + path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "x-platform-reason": reason,
        ...(active ? { "x-csrf-token": active.csrfToken } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (current !== generation.current) throw new Error("");
    if (!response.ok) {
      if (response.status === 401) clearSession();
      const problem = await response.json().catch(() => ({})) as { code?: unknown; requestId?: unknown; correlationId?: unknown };
      const requestId = typeof problem.requestId === "string" && UUID_PATTERN.test(problem.requestId)
        ? problem.requestId
        : undefined;
      const reportedCorrelationId = typeof problem.correlationId === "string" && UUID_PATTERN.test(problem.correlationId)
        ? problem.correlationId
        : undefined;
      const correlationId = reportedCorrelationId === requestId ? reportedCorrelationId : requestId;
      const code = typeof problem.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(problem.code)
        ? problem.code
        : undefined;
      const message = path.includes('/chatwoot')
        ? 'Falha na integração'
        :
        response.status === 401
          ? mfaRequired
            ? "Sessão expirada ou credenciais inválidas. Entre novamente com seu autenticador."
            : "Sessão expirada ou e-mail e senha inválidos. Entre novamente."
          : response.status === 403
            ? "Esta ação não é permitida para o seu acesso JRC."
            : response.status === 429
              ? "Limite de tentativas atingido. Aguarde antes de tentar novamente."
              : response.status >= 500
                ? "Serviço temporariamente indisponível. Tente novamente."
                : "Não foi possível concluir. Revise os dados e tente novamente.";
      throw new ApiClientError(message, response.status, requestId, code, correlationId);
    }
    const result =
      response.status === 204
        ? (undefined as T)
        : ((await response.json()) as T);
    if (current !== generation.current) throw new Error("");
    return result;
  }
  useEffect(() => {
    let active = true;
    void Promise.all([
      fetch("/v1/platform/auth/config", {
        credentials: "same-origin",
        cache: "no-store",
      })
        .then(async (response) => {
          if (response.ok) {
            const configuration = (await response.json()) as {
              mfaRequired?: boolean;
            };
            if (active) setMfaRequired(configuration.mfaRequired !== false);
          }
        })
        .catch(() => undefined),
      fetch("/v1/platform/auth/session", {
        credentials: "same-origin",
        cache: "no-store",
      })
        .then(async (response) => {
          if (response.ok) {
            const restored = (await response.json()) as StaffSession;
            if (active) setSession(restored);
          }
        })
        .catch(() => {
          if (active)
            setError(
              "Administração indisponível. Verifique a configuração do serviço.",
            );
        }),
    ]).finally(() => {
      if (active) setBooting(false);
    });
    return () => {
      active = false;
    };
  }, []);
  async function loadCompanies(active = session) {
    const version = ++listVersion.current;
    setCompaniesLoading(true);
    setCompaniesLoaded(false);
    try {
      const data = await request<{ organizations: Company[] }>(
        "/organizations",
        "GET",
        undefined,
        active,
      );
      if (version === listVersion.current) {
        setCompanies(data.organizations);
        setCompaniesLoaded(true);
      }
    } finally {
      if (version === listVersion.current) setCompaniesLoading(false);
    }
  }
  useEffect(() => {
    if (session)
      void loadCompanies().catch((e) => {
        if ((e as Error).message) setError(platformErrorMessage(e));
      });
  }, [session]);
  async function action(operation: () => Promise<void>) {
    const current = generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (e) {
      if ((e as Error).message) setError(platformErrorMessage(e));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  async function inspect(company: Company) {
    const version = ++inspection.current;
    setSelected(company);
    setCreating(false);
    setMembers(null);
    setMonitor(null);
    setInspecting(true);
    setError("");
    setNotice("");
    try {
      const [users, stats] = await Promise.all([
        request<{ memberships: Member[] }>(
          "/organizations/" + company.id + "/memberships",
        ),
        request<Monitor>("/organizations/" + company.id + "/monitor"),
      ]);
      if (version === inspection.current) {
        setMembers(users.memberships);
        setMonitor(stats);
      }
    } catch (e) {
      if (version === inspection.current) setError(platformErrorMessage(e));
    } finally {
      if (version === inspection.current) setInspecting(false);
    }
  }
  function openCompany(company: Company) {
    if (dashboard) navigate("/jrc/empresas");
    void inspect(company);
  }
  function closeCompany() {
    inspection.current++;
    setSelected(null);
    setMembers(null);
    setMonitor(null);
    setInspecting(false);
    setError("");
    setNotice("");
  }

  if (booting)
    return (
      <main className="centered-state" role="status">
        Verificando acesso JRC…
      </main>
    );
  if (!session)
    return (
      <main className="auth-page admin-auth">
        <section className="auth-card">
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
          <h1>Administração JRC</h1>
          <p>
            {mfaRequired
              ? "Acesso exclusivo da equipe JRC, com senha e autenticação em duas etapas."
              : "Entre com o e-mail e a senha da equipe JRC."}
          </p>
          {error && (
            <div className="notice notice--error" role="alert">
              {error}
            </div>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void action(async () => {
                const logged = await request<StaffSession>(
                  "/auth/login",
                  "POST",
                  {
                    email: data.get("email"),
                    password: data.get("password"),
                    ...(mfaRequired ? { totp: data.get("totp") } : {}),
                  },
                );
                setSession(logged);
              });
            }}
          >
            <label htmlFor="staff-email">E-mail JRC</label>
            <input
              id="staff-email"
              name="email"
              type="email"
              autoComplete="username"
              required
            />
            <label htmlFor="staff-password">Senha</label>
            <input
              id="staff-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
            {mfaRequired && (
              <>
                <label htmlFor="staff-totp">Código do autenticador</label>
                <input
                  id="staff-totp"
                  name="totp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  placeholder="6 números"
                  aria-describedby="staff-totp-help"
                  required
                  onInvalid={(event) =>
                    event.currentTarget.setCustomValidity(
                      "Digite os 6 números gerados pelo aplicativo autenticador. A chave de configuração deve ser cadastrada no aplicativo.",
                    )
                  }
                  onInput={(event) => event.currentTarget.setCustomValidity("")}
                />
                <small id="staff-totp-help">
                  Use os 6 números gerados pelo aplicativo autenticador. O
                  código muda a cada 30 segundos.
                </small>
                <details className="notice">
                  <summary>Como configurar o primeiro acesso</summary>
                  <ol>
                    <li>
                      Abra seu aplicativo autenticador no celular e adicione uma
                      conta.
                    </li>
                    <li>
                      Escaneie o QR Code de matrícula entregue pela JRC, ou
                      cadastre a chave de configuração completa como uma conta
                      baseada em tempo.
                    </li>
                    <li>
                      Volte a esta tela e digite os 6 números exibidos no
                      aplicativo.
                    </li>
                  </ol>
                  <p>
                    O QR de matrícula e a chave são usados somente dentro do
                    autenticador.
                  </p>
                </details>
              </>
            )}
            <button className="button button--primary" disabled={busy}>
              {busy ? "Verificando…" : "Entrar na administração"}
            </button>
          </form>
          <Link to="/login">Acessar o portal da minha empresa</Link>
        </section>
      </main>
    );
  async function createCompany(data: FormData, limits: Limits) {
    await action(async () => {
      await request("/organizations", "POST", {
        name: data.get("name"),
        slug: data.get("slug"),
        ownerEmail: data.get("ownerEmail"),
        ownerPassword: data.get("ownerPassword"),
        flowsEnabled: data.has("flowsEnabled"),
        plan: data.get("plan"),
        limits,
      });
      setCreating(false);
      await loadCompanies();
      setNotice("Empresa cadastrada com responsável e limites.");
    });
  }
  async function saveCompany(data: FormData) {
    if (!selected) return;
    const company = selected;
    await action(async () => {
      const status = data.get("status") as Company["status"];
      const plan = String(data.get("plan"));
      const feature = data.has("flowsConfigPresent") ? { flowsEnabled: data.has("flowsEnabled") } : {};
      const values = limitKeys.map((key) => String(data.get(key) ?? "").trim());
      if (
        values.some(Boolean) &&
        !values.every(
          (value) =>
            Number.isInteger(Number(value)) &&
            Number(value) > 0 &&
            Number(value) <= 100000000,
        )
      )
        throw new Error(
          "Preencha os quatro limites com números inteiros maiores que zero.",
        );
      const limits = values.every(Boolean)
        ? (Object.fromEntries(
            limitKeys.map((key) => [key, Number(data.get(key))]),
          ) as unknown as Limits)
        : undefined;
      await request("/organizations/" + company.id, "PATCH", {
        status,
        plan,
        ...(limits ? { limits } : {}),
        ...feature,
      });
      setSelected((current) =>
        current?.id === company.id
          ? { ...current, status, plan, ...feature, ...(limits ? { limits } : {}) }
          : current,
      );
      await loadCompanies();
      setNotice("Configuração da empresa atualizada e auditada.");
    });
  }
  async function saveMember(data: FormData, form: HTMLFormElement) {
    if (!selected) return;
    const company = selected;
    const version = inspection.current;
    await action(async () => {
      await request("/organizations/" + company.id + "/memberships", "PUT", {
        email: data.get("email"),
        ...(data.get("password") ? { password: data.get("password") } : {}),
        role: data.get("role"),
        status: data.get("status"),
      });
      const result = await request<{ memberships: Member[] }>(
        "/organizations/" + company.id + "/memberships",
      );
      if (version === inspection.current) {
        setMembers(result.memberships);
        form.reset();
        setNotice("Acesso do usuário atualizado.");
      }
    });
  }

  return (
    <PlatformShell
      session={session}
      busy={busy}
      logout={() =>
        void action(async () => {
          await request("/auth/logout", "POST", {});
          clearSession();
        })
      }
    >
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            ADMINISTRAÇÃO / {section.label.toLocaleUpperCase("pt-BR")}
          </p>
          <h1>{creating ? "Cadastrar empresa" : section.title}</h1>
          <p>{section.description}</p>
        </div>
        <div className="heading-actions">
          <button
            className="button button--ghost"
            disabled={disabled || companiesLoading}
            onClick={() => void action(() => loadCompanies())}
          >
            <Icon name="refresh" size={15} /> Atualizar empresas
          </button>
          {admin && !creating && section.path !== '/jrc/grupos' && (
            <button
              className="button button--primary"
              disabled={busy}
              onClick={() => {
                closeCompany();
                setCreating(true);
              }}
            >
              <Icon name="plus" size={16} /> Cadastrar empresa
            </button>
          )}
        </div>
      </div>
      {error && (
        <div className="notice notice--error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      {section.path === '/jrc/grupos' ? (
        <EconomicGroups key={session.user.id} request={request} companies={companies} admin={!!admin} disabled={disabled || !companiesLoaded} />
      ) : creating && admin ? (
        <NewCompany
          disabled={disabled}
          cancel={() => setCreating(false)}
          submit={createCompany}
        />
      ) : (
        <>
          {companiesLoading && (
            <div className="loading-panels" role="status">
              Carregando empresas…
            </div>
          )}
          {!companiesLoading && !companiesLoaded && (
            <div className="panel admin-empty">
              <Icon name="providers" size={30} />
              <h2>Consulta indisponível</h2>
              <p>
                Os indicadores estarão disponíveis após carregar as empresas.
              </p>
            </div>
          )}
          {companiesLoaded && (
            <>
              {(dashboard || !selected) && (
                <AdminMetrics companies={companies} />
              )}
              {dashboard && <AdminCharts companies={companies} />}
              {!dashboard && selected ? (
                <>
                  <div className="admin-selection">
                    <button
                      className="admin-text-link"
                      disabled={busy}
                      onClick={closeCompany}
                    >
                      ← Todas as empresas
                    </button>
                    <label>
                      Empresa em atendimento
                      <select
                        value={selected.id}
                        disabled={disabled}
                        onChange={(event) => {
                          const company = companies.find(
                            (c) => c.id === event.target.value,
                          );
                          if (company) void inspect(company);
                        }}
                      >
                        {companies.map((company) => (
                          <option key={company.id} value={company.id}>
                            {company.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <CompanyWorkspace
                    key={selected.id + "-" + section.path}
                    company={selected}
                    members={members}
                    monitor={monitor}
                    loading={inspecting}
                    admin={!!admin}
                    disabled={disabled || inspecting}
                    defaultTab={defaultTab}
                    saveCompany={saveCompany}
                    saveMember={saveMember}
                    refresh={() => void inspect(selected)}
                    channelRequest={(path,method,body)=>request('/organizations/'+selected.id+'/channels'+path,method,body)}
                    integrationRequest={(path,method,body)=>request('/organizations/'+selected.id+'/chatwoot'+path,method,body)}
                    acknowledge={() =>
                      void action(async () => {
                        await request(
                          "/organizations/" +
                            selected.id +
                            "/support-acknowledgment",
                          "POST",
                          {},
                        );
                        setNotice(
                          "Atendimento registrado na auditoria da empresa.",
                        );
                      })
                    }
                  />
                </>
              ) : (
                <>
                  {!dashboard && section.path !== "/jrc/empresas" && (
                    <div className="admin-section-hint">
                      <Icon name={section.icon} />
                      <span>
                        Selecione uma empresa abaixo para acessar{" "}
                        {section.label.toLocaleLowerCase("pt-BR")}.
                      </span>
                    </div>
                  )}
                  <CompanyTable
                    key={section.path}
                    companies={companies}
                    disabled={disabled}
                    open={openCompany}
                    compact={dashboard}
                  />
                </>
              )}
            </>
          )}
        </>
      )}
      <section
        className="admin-audit-context"
        aria-label="Contexto do atendimento"
      >
        <span className="admin-audit-icon">
          <Icon name="key" size={17} />
        </span>
        <label htmlFor="support-reason">
          Motivo do atendimento
          <small>Registrado nas consultas e alterações.</small>
        </label>
        <input
          id="support-reason"
          aria-label="Motivo do atendimento"
          minLength={5}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Informe o motivo da consulta ou alteração"
        />
        {reason.trim().length < 5 && (
          <small role="status">Informe pelo menos 5 caracteres.</small>
        )}
      </section>
      <footer className="admin-footer">
        <span>
          JRC Broker <span>·</span> Administração da plataforma
        </span>
        <span>Gestão de empresas e canais WhatsApp</span>
      </footer>
    </PlatformShell>
  );
}
