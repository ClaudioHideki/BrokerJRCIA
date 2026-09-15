import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useApiClient, useSession } from "../auth/SessionProvider.js";

interface Connection {
  id: string;
  channelId: string;
  wabaId: string;
  phoneNumberId: string;
  status: "PENDING" | "READY" | "REVOKED";
  pending: string[];
}
interface Signup {
  state: string;
  expiresAt: string;
  appId: string;
  configId: string;
  graphVersion: string;
}
interface FacebookSdk {
  init(options: {
    appId: string;
    version: string;
    cookie: boolean;
    xfbml: boolean;
  }): void;
  login(
    callback: (response: { authResponse?: { code?: string } }) => void,
    options: Record<string, unknown>,
  ): void;
}
declare global {
  interface Window {
    FB?: FacebookSdk;
  }
}
let sdkFlight: Promise<FacebookSdk> | undefined;
export function loadFacebookSdk(): Promise<FacebookSdk> {
  if (window.FB) return Promise.resolve(window.FB);
  return (sdkFlight ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://connect.facebook.net/pt_BR/sdk.js";
    script.async = true;
    script.onload = () =>
      window.FB ? resolve(window.FB) : reject(new Error("SDK indisponível"));
    script.onerror = () => {
      sdkFlight = undefined;
      script.remove();
      reject(new Error("Não foi possível carregar a conexão Meta."));
    };
    document.head.append(script);
  }));
}
const pendingLabels: Record<string, string> = {
  PHONE_REGISTRATION_REQUIRED: "Registrar o número",
  META_PAYMENT_METHOD_REQUIRED: "Configurar pagamento na Meta",
  META_BUSINESS_REVIEW_REQUIRED: "Concluir análise da empresa na Meta",
  WEBHOOK_SUBSCRIPTION_REQUIRED: "Concluir assinatura dos eventos",
  META_PERMISSION_REMOVAL_EXTERNAL:
    "Revisar permissões do aplicativo nas configurações Meta",
  META_HEALTH_UNAVAILABLE: "Verificar disponibilidade do número na Meta",
};
export function MetaConnectPage() {
  const client = useApiClient();
  const { session, tenantRevision } = useSession();
  const organizationId = session?.activeOrganization.id;
  const [connections, setConnections] = useState<Connection[]>([]);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [signup, setSignup] = useState<Signup | null>(null);
  const version = useRef(0);
  const stop = useRef<(() => void) | null>(null);
  const canManage =
    session?.activeOrganization.role === "OWNER" ||
    session?.activeOrganization.role === "ADMIN";
  async function load(current = version.current, signal?: AbortSignal) {
    if (current !== version.current) return;
    const data = await client.request<{
      configured: boolean;
      connections: Connection[];
    }>("/v1/meta-onboarding", signal ? { signal } : undefined);
    if (current === version.current) {
      setConfigured(data.configured);
      setConnections(data.connections);
    }
  }
  useLayoutEffect(() => {
    const controller = new AbortController();
    const current = ++version.current;
    setConfigured(false);
    setConnections([]);
    setSignup(null);
    setError("");
    setNotice("");
    setLoading(true);
    setBusy(false);
    stop.current?.();
    if (canManage)
      void load(current, controller.signal)
        .catch(() => {
          if (current === version.current)
            setError("Não foi possível consultar suas conexões oficiais.");
        })
        .finally(() => {
          if (current === version.current) setLoading(false);
        });
    else setLoading(false);
    return () => {
      version.current++;
      controller.abort();
      stop.current?.();
    };
  }, [client, tenantRevision, canManage, organizationId]);
  async function action(operation: (current: number) => Promise<void>) {
    const current = version.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation(current);
    } catch {
      if (current === version.current)
        setError(
          "Não foi possível concluir. Verifique as pendências ou tente novamente.",
        );
    } finally {
      if (current === version.current) setBusy(false);
    }
  }
  function authorize() {
    if (!signup || !window.FB) return;
    const current = version.current;
    setBusy(true);
    setError("");
    let code: string | undefined;
    let assets: { wabaId: string; phoneNumberId: string } | undefined;
    let completing = false;
    const cleanup = () => {
      window.removeEventListener("message", receive);
      clearTimeout(timer);
      stop.current = null;
    };
    const complete = () => {
      if (!code || !assets || completing || current !== version.current) return;
      completing = true;
      cleanup();
      void action(async () => {
        await client.request("/v1/meta-onboarding/complete", {
          method: "POST",
          body: JSON.stringify({ state: signup.state, code, ...assets }),
        });
        if (current !== version.current) return;
        setSignup(null);
        await load(current);
        if (current === version.current)
          setNotice(
            "Autorização recebida. Confira as etapas restantes para ativar o número.",
          );
      });
    };
    const receive = (event: MessageEvent) => {
      if (
        !["https://www.facebook.com", "https://facebook.com"].includes(
          event.origin,
        )
      )
        return;
      let data: unknown;
      try {
        data =
          typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      const item = data as {
        type?: string;
        event?: string;
        data?: { waba_id?: string; phone_number_id?: string };
      };
      if (
        item?.type === "WA_EMBEDDED_SIGNUP" &&
        item.event === "FINISH" &&
        /^\d+$/.test(item.data?.waba_id ?? "") &&
        /^\d+$/.test(item.data?.phone_number_id ?? "")
      ) {
        assets = {
          wabaId: item.data!.waba_id!,
          phoneNumberId: item.data!.phone_number_id!,
        };
        complete();
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      if (current === version.current) {
        setBusy(false);
        setSignup(null);
        setError("Autorização não concluída no prazo. Inicie novamente.");
      }
    }, 180_000);
    window.addEventListener("message", receive);
    stop.current = cleanup;
    window.FB.login(
      (response) => {
        if (current !== version.current) return;
        code = response.authResponse?.code;
        if (!code) {
          cleanup();
          setBusy(false);
          setSignup(null);
          setNotice("Autorização cancelada. Seus ativos permanecem na Meta.");
          return;
        }
        complete();
      },
      {
        config_id: signup.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, sessionInfoVersion: "3" },
      },
    );
  }
  return (
    <section className="page-content">
      <div className="page-heading">
        <div>
          <h1>WhatsApp oficial</h1>
          <p>
            Conecte os ativos da sua empresa ao aplicativo JRC com autorização
            da Meta.
          </p>
        </div>
        <Link className="button button--primary" to="/mensagens">
          Abrir conversas
        </Link>
      </div>
      {!canManage ? (
        <div className="state-card">
          Somente o proprietário ou administrador da empresa pode gerenciar a
          autorização Meta.
        </div>
      ) : (
        <>
          {error && (
            <p className="notice notice--error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="notice">
              {notice}
            </p>
          )}
          <section className="panel">
            <h2>Conectar uma conta</h2>
            <p>
              Entre na Meta, escolha a empresa e autorize o número. Os ativos
              continuam pertencendo à sua empresa.
            </p>
            {loading ? (
              <p role="status">Consultando configuração…</p>
            ) : !configured ? (
              <p>
                A conexão oficial está aguardando configuração do aplicativo
                JRC. Entre em contato com o suporte.
              </p>
            ) : signup ? (
              <button
                className="button button--primary"
                disabled={busy}
                onClick={authorize}
              >
                {busy ? "Aguardando Meta…" : "Continuar na Meta"}
              </button>
            ) : (
              <button
                className="button button--primary"
                disabled={busy}
                onClick={() =>
                  void action(async (current) => {
                    const [ready, sdk] = await Promise.all([
                      client.request<Signup>("/v1/meta-onboarding/start", {
                        method: "POST",
                        body: "{}",
                      }),
                      loadFacebookSdk(),
                    ]);
                    if (current !== version.current) return;
                    sdk.init({
                      appId: ready.appId,
                      version: ready.graphVersion,
                      cookie: false,
                      xfbml: false,
                    });
                    setSignup(ready);
                  })
                }
              >
                {busy ? "Preparando…" : "Preparar conexão oficial"}
              </button>
            )}
          </section>
          <section
            className="panel meta-connection-guide"
            aria-labelledby="meta-connection-guide-title"
          >
            <h2 id="meta-connection-guide-title">
              Como funciona a conexão oficial
            </h2>
            <p>
              Após a liberação do aplicativo JRC, o responsável pela empresa
              realiza a autorização na janela da Meta.
            </p>
            <ol className="meta-connection-steps">
              <li>
                <strong>Autorizar a empresa</strong>
                <p>
                  Entre com seu Facebook e escolha o portfólio empresarial que
                  possui os ativos do WhatsApp.
                </p>
              </li>
              <li>
                <strong>Selecionar o número</strong>
                <p>
                  Selecione ou cadastre a conta WhatsApp Business e o número que
                  será usado no atendimento.
                </p>
              </li>
              <li>
                <strong>Concluir as verificações</strong>
                <p>
                  Conclua a validação do número e as pendências de cadastro,
                  pagamento e permissões apresentadas pela Meta.
                </p>
              </li>
              <li>
                <strong>Validar envio e recebimento</strong>
                <p>
                  Confira a situação da conexão e realize um teste autorizado
                  antes de iniciar o atendimento.
                </p>
              </li>
            </ol>
            <p>
              Os ativos continuam pertencendo à sua empresa. A chave de API JRC
              não substitui esta autorização. Vincular o canal ao JRC Conversa é
              uma etapa adicional de integração.
            </p>
          </section>
          <h2>Contas autorizadas</h2>
          {!connections.length && !loading && (
            <p>Nenhuma conta oficial autorizada nesta empresa.</p>
          )}
          <ul className="connection-grid">
            {connections.map((connection) => (
              <li key={connection.id} className="panel">
                <h3>Número Meta {connection.phoneNumberId}</h3>
                <span
                  className={`status status--${connection.status === "READY" ? "success" : connection.status === "REVOKED" ? "danger" : "pending"}`}
                >
                  {connection.status === "READY"
                    ? "Pronto para envio"
                    : connection.status === "REVOKED"
                      ? "Autorização desativada"
                      : "Etapas pendentes"}
                </span>
                <ul>
                  {connection.pending.map((item) => (
                    <li key={item}>
                      {pendingLabels[item] ?? "Verificar pendência na Meta"}
                    </li>
                  ))}
                </ul>
                {connection.status !== "REVOKED" && (
                  <>
                    <div className="dialog-actions">
                      <button
                        className="button button--secondary"
                        disabled={busy}
                        onClick={() =>
                          void action(async (current) => {
                            await client.request(
                              `/v1/meta-onboarding/${connection.id}/refresh`,
                              { method: "POST", body: "{}" },
                            );
                            await load(current);
                            if (current === version.current)
                              setNotice("Situação consultada na Meta.");
                          })
                        }
                      >
                        Verificar pendências
                      </button>
                      <button
                        className="button button--ghost"
                        disabled={busy}
                        onClick={() =>
                          void action(async (current) => {
                            await client.request(
                              `/v1/meta-onboarding/${connection.id}/revoke`,
                              { method: "POST", body: "{}" },
                            );
                            await load(current);
                            if (current === version.current)
                              setNotice(
                                "Envios desta autorização desativados na JRC. Revise também as permissões na Meta.",
                              );
                          })
                        }
                      >
                        Desativar autorização JRC
                      </button>
                    </div>
                    {connection.pending.includes(
                      "PHONE_REGISTRATION_REQUIRED",
                    ) && (
                      <form
                        className="form-grid"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const form = event.currentTarget;
                          const pin = new FormData(form).get("pin");
                          void action(async (current) => {
                            await client.request(
                              `/v1/meta-onboarding/${connection.id}/register`,
                              { method: "POST", body: JSON.stringify({ pin }) },
                            );
                            if (current !== version.current) return;
                            form.reset();
                            await load(current);
                          });
                        }}
                      >
                        <label>
                          PIN de verificação em duas etapas
                          <input
                            name="pin"
                            type="password"
                            inputMode="numeric"
                            pattern="[0-9]{6}"
                            maxLength={6}
                            required
                            autoComplete="off"
                          />
                        </label>
                        <button
                          className="button button--primary"
                          disabled={busy}
                        >
                          Registrar número na Meta
                        </button>
                      </form>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
