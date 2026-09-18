import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ChatwootStatusSchema,
  IntegrationJobsSchema,
  type ChatwootStatus,
  type IntegrationJob,
} from "@jrc/contracts";
import { Metric } from "../broker/components.js";
import { Icon } from "../broker/Icon.js";
import "./integrations.css";
import { ChatwootDestinationPanel } from './ChatwootDestinationPanel.js';
import { DashboardAppSetup } from './DashboardAppSetup.js';
import { ChatwootControlPanel } from './ChatwootControlPanel.js';
import { NativeJrcSetup } from './NativeJrcSetup.js';

export type IntegrationRequest = (
  path: string,
  method?: string,
  body?: unknown,
  options?: { idempotencyKey: string },
) => Promise<unknown>;
interface Source {
  id: string;
  kind: "instance" | "channel";
  name: string;
  label: string;
}
interface Inbox {
  id: number;
  name: string;
  hasWebhook: boolean;
}
const states: Record<string, string> = {
  READY: "Pronta",
  PENDING: "Pendente",
  RUNNING: "Processando",
  FAILED: "Falha",
  UNKNOWN: "Conferência necessária",
  DISABLED: "Pausada",
  SUCCEEDED: "Concluída",
};
const stages: Record<string, string> = {
  ACCOUNT: "Criação da conta",
  USER: "Cadastro do responsável",
  ACCESS: "Permissões de acesso",
  VERIFY: "Verificação",
  DONE: "Concluído",
};
const errors: Record<string, string> = {
  CHATWOOT_DESTINATION_REQUIRED: 'Escolha uma instalação e solicite a aprovação da equipe JRC.',
  CHATWOOT_DESTINATION_NOT_APPROVED: 'O destino precisa ser aprovado pela equipe JRC antes de vincular a conta.',
  CHATWOOT_CONTEXT_CHANGED: 'A configuração mudou durante a validação. Atualize os dados e tente novamente.',
  DESTINATION_IN_USE: 'Existem caixas ou um cadastro em andamento neste destino. Conclua a migração antes de alterá-lo.',
  CHATWOOT_MESSAGE_NOT_CONFIRMED:
    "A mensagem ainda não foi localizada. Informe seu ID no JRC Conversas ou confira o destino antes de continuar.",
  CHATWOOT_CONVERSATION_ID_REQUIRED:
    "Informe o ID da conversa criada no JRC Conversas.",
  CHATWOOT_CONVERSATION_MISMATCH:
    "A conversa informada não corresponde ao contato e à caixa desta entrega.",
  CHATWOOT_CONTACT_NOT_CONFIRMED:
    "O contato ou seu vínculo com a caixa ainda não foi confirmado no JRC Conversas.",
  CHATWOOT_ACCOUNT_ACCESS_REQUIRED:
    "O token precisa pertencer a um administrador desta conta.",
  CHATWOOT_REQUEST_REJECTED:
    "O JRC Conversas recusou a operação. Confira a conta, o token e as permissões.",
  CHATWOOT_PLATFORM_NOT_CONFIGURED:
    "A criação automática depende da configuração da plataforma JRC Conversas no servidor.",
  CHATWOOT_WEBHOOK_REPLACEMENT_REQUIRED:
    "Essa caixa já tem um webhook. Confirme a substituição para mudar seu atendimento para o broker.",
  CHATWOOT_OUTCOME_UNKNOWN:
    "A resposta do JRC Conversas não foi confirmada. Confira o recurso criado antes de continuar.",
  PROVISIONING_REQUIRES_RECONCILIATION:
    "Confira o recurso no JRC Conversas e informe seu ID para continuar sem duplicar o cadastro.",
  PROVISIONING_IN_PROGRESS:
    "O cadastro está sendo processado. Atualize os dados em instantes.",
  PROVISIONING_ACCOUNT_MISMATCH:
    "A conta informada não corresponde ao cadastro desta empresa.",
  PROVISIONING_USER_MISMATCH:
    "O usuário informado não corresponde ao responsável deste cadastro.",
  PROVISIONING_REMOTE_ID_REQUIRED:
    "Informe o ID do recurso criado no JRC Conversas.",
  PROVISIONING_ACCESS_NOT_CONFIRMED:
    "A permissão de administrador ainda não foi confirmada no JRC Conversas.",
  INTEGRATION_ALREADY_BOUND:
    "A conta ou caixa já está vinculada. Confira a empresa e a conexão selecionadas.",
  CHATWOOT_ACCOUNT_ALREADY_BOUND:
    "Esta empresa já tem uma conta vinculada ou um cadastro em andamento.",
  CHATWOOT_INBOX_RECONCILIATION_REQUIRED:
    "Não foi encontrada uma única caixa com esse webhook. Confira sua configuração no JRC Conversas.",
  CHATWOOT_WEBHOOK_NOT_READY:
    "O webhook da caixa ainda precisa ser configurado ou verificado.",
  JOB_REQUIRES_RECONCILIATION:
    "O resultado desta entrega precisa ser conferido antes de um novo envio.",
  QR_NOT_CONFIGURED: "O canal QR aguarda configuração no servidor.",
  CHATWOOT_AGENT_NOT_IN_ACCOUNT:
    "Selecione atendentes cadastrados nesta conta do JRC Conversas.",
  CHATWOOT_CONVERSATION_ALREADY_BOUND:
    "Este contato já tem uma conversa vinculada. Continue o atendimento na conversa existente.",
  MEDIA_NOT_READY:
    "O anexo ainda está sendo armazenado. A entrega será retomada pela fila.",
  MEDIA_STORAGE_LIMIT:
    "O armazenamento de anexos da empresa atingiu o limite. Ajuste a capacidade antes de repetir.",
  MEDIA_ORIGIN_NOT_ALLOWED:
    "O armazenamento do JRC Conversas usa um domínio que precisa ser autorizado no servidor do broker.",
  MEDIA_TYPE_UNSUPPORTED:
    "O formato deste anexo não é compatível com o canal WhatsApp.",
  CUSTOMER_SERVICE_WINDOW_CLOSED:
    "A janela de atendimento da Meta expirou. Use um template aprovado ou aguarde uma mensagem do contato.",
  CONTACT_CONSENT_REQUIRED:
    "O contato não tem autorização para esse envio ou solicitou a interrupção das mensagens.",
  ORGANIZATION_NOT_ACTIVE:
    "A empresa está suspensa ou desativada. Reative-a para realizar alterações.",
};
export function integrationError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  return (
    errors[code] ??
    "Não foi possível concluir a operação. Atualize os dados e confira as pendências."
  );
}
export function ChatwootPanel({
  request,
  canManage,
  platform,
  disabled = false,
  companyName = "Minha empresa",
  ownerEmail = "",
}: {
  request: IntegrationRequest;
  canManage: boolean;
  platform: boolean;
  disabled?: boolean;
  companyName?: string;
  ownerEmail?: string;
}) {
  const api = useRef(request);
  api.current = request;
  const live = useRef(true),
    generation = useRef(0),
    running = useRef(false);
  const [data, setData] = useState<ChatwootStatus | null>(null),
    [jobs, setJobs] = useState<IntegrationJob[]>([]);
  const [sources, setSources] = useState<Source[]>([]),
    [inboxes, setInboxes] = useState<Inbox[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [source, setSource] = useState(""),
    [selectedInbox, setSelectedInbox] = useState(""),
    [reason, setReason] = useState("Correção verificada pelo administrador");
  const [search, setSearch] = useState("");
  const blocked = busy || disabled;
  async function load() {
    const current = ++generation.current,
      send = api.current;
    const status = ChatwootStatusSchema.parse(await send(""));
    if (!live.current || current !== generation.current) return;
    setData(status);
    if (!status.configured) return;
    const results = await Promise.allSettled([
      send("/jobs").then((value) => {
        const result = IntegrationJobsSchema.parse(value);
        if (live.current && current === generation.current)
          setJobs(result.data);
      }),
      ...(canManage
        ? [
            send("/sources").then((value) => {
              if (live.current && current === generation.current)
                setSources((value as { data: Source[] }).data);
            }),
          ]
        : []),
      ...(canManage && status.account?.status === "READY"
        ? [
            send("/inboxes").then((value) => {
              if (live.current && current === generation.current)
                setInboxes((value as { data: Inbox[] }).data);
            }),
          ]
        : []),
    ]);
    if (
      results.some((r) => r.status === "rejected") &&
      live.current &&
      current === generation.current
    )
      setError(
        "Alguns dados não puderam ser consultados. Atualize antes de configurar a caixa.",
      );
  }
  useEffect(() => {
    live.current = true;
    void load().catch(() => {
      if (live.current) setError("Não foi possível consultar a integração.");
    });
    return () => {
      live.current = false;
      generation.current++;
    };
  }, []);
  async function action(
    path: string,
    method = "POST",
    body: unknown = {},
    success = "Configuração atualizada.",
  ) {
    if (running.current || disabled) return;
    running.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.current(path, method, body);
      if (live.current) {
        setNotice(success);
        await load();
      }
    } catch (failure) {
      if (live.current) {
        setError(integrationError(failure));
        await load().catch(() => undefined);
      }
    } finally {
      running.current = false;
      if (live.current) setBusy(false);
    }
  }
  function submit(
    event: FormEvent<HTMLFormElement>,
    perform: (form: FormData) => void,
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    event.currentTarget.reset();
    perform(form);
  }
  const selected = inboxes.find((i) => String(i.id) === selectedInbox);
  const accountReady = data?.account?.status === "READY";
  const queue = jobs.filter(
    (job) =>
      !search ||
      [job.id, job.messageId, job.integrationId].some((value) =>
        value?.includes(search.trim()),
      ),
  );
  return (
    <div className="jrc-integration">
      <div className="integration-toolbar">
        <div>
          <h2>Integração com o JRC Conversas</h2>
          <p>
            Uma conta por empresa e uma caixa de atendimento para cada WhatsApp.
          </p>
        </div>
        <button
          className="button button--secondary"
          disabled={blocked}
          onClick={() =>
            void load().catch(() => setError("Não foi possível atualizar."))
          }
        >
          <Icon name="refresh" size={15} /> Atualizar integração
        </button>
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
      {!data && !error && <p role="status">Consultando integração…</p>}
      {data && !data.configured && (
        <section className="panel">
          <h3>Configuração pendente</h3>
          <p>
            O JRC Conversas está aguardando configuração no servidor. A equipe
            JRC precisa definir o endereço da instalação e o endereço público do
            broker.
          </p>
        </section>
      )}
      {data?.configured && (
        <>
          {data.externalDestinationsEnabled && <ChatwootDestinationPanel key={`${data.destination?.baseUrl}:${data.destination?.revision}`}
            data={data} platform={platform} canManage={canManage} blocked={blocked} action={action} />}
          {!platform && accountReady && data.controlEnabled && <ChatwootControlPanel request={request} canManage={canManage} connections={data.connections} />}
          {!platform && canManage && accountReady && data.controlEnabled && data.baseUrl && data.destination?.mode !== 'EXTERNAL' && <NativeJrcSetup key={`${data.account!.accountId}:${data.destination?.revision}:${data.baseUrl}`} request={request} accountId={data.account!.accountId!} baseUrl={data.baseUrl} />}
          {!platform && accountReady && data.controlEnabled && data.embedEnabled && canManage && <DashboardAppSetup request={request} />}
          <div className="metric-grid metric-grid--four">
            <Metric
              label="Conta de atendimento"
              value={
                data.account?.accountId ? String(data.account.accountId) : "—"
              }
              note={
                data.account
                  ? states[data.account.status]!
                  : "Ainda não vinculada"
              }
              icon="providers"
            />
            <Metric
              label="Caixas prontas"
              value={String(
                data.connections.filter((c) => c.status === "READY").length,
              )}
              note="Conexões configuradas"
              tone="green"
              icon="connections"
            />
            <Metric
              label="Entregas pendentes"
              value={String(
                (data.jobs.PENDING ?? 0) + (data.jobs.RUNNING ?? 0),
              )}
              note="Fila persistente"
              icon="messages"
            />
            <Metric
              label="Precisam de atenção"
              value={String((data.jobs.FAILED ?? 0) + (data.jobs.UNKNOWN ?? 0))}
              note="Confira a fila abaixo"
              tone="amber"
              icon="health"
            />
          </div>
          <section className="panel integration-account">
            <div>
              <h3>1. Conta da empresa</h3>
              <p>{companyName}</p>
              {data.baseUrl && (
                <a
                  href={
                    data.account?.accountId
                      ? `${data.baseUrl}/app/accounts/${data.account.accountId}/dashboard`
                      : data.baseUrl
                  }
                  target="_blank"
                  rel="noreferrer"
                >
                  Abrir JRC Conversas ↗
                </a>
              )}
            </div>
            <div>
              {accountReady ? (
                <p className="integration-ready">
                  Conta {data.account!.accountId} vinculada. Credencial
                  armazenada.
                </p>
              ) : (
                <p>
                  Vincule uma conta existente ou crie uma conta exclusiva para
                  esta empresa.
                </p>
              )}
              {!canManage && (
                <p>
                  Peça ao administrador da empresa para configurar a integração.
                </p>
              )}
              {canManage &&
                (!data.externalDestinationsEnabled || data.destination?.approvalStatus === 'APPROVED') &&
                (!data.provisioning || data.provisioning.state === "READY") && (
                  <details open={!accountReady}>
                    <summary>
                      {accountReady
                        ? "Atualizar credencial da conta"
                        : "Vincular conta existente"}
                    </summary>
                    <form
                      onSubmit={(e) =>
                        submit(
                          e,
                          (form) =>
                            void action(
                              "/account",
                              "PUT",
                              {
                                accountId: Number(form.get("accountId")),
                                token: String(form.get("token")),
                              },
                              "Conta validada e vinculada.",
                            ),
                        )
                      }
                      className="integration-form"
                    >
                      <label>
                        ID da conta
                        <input
                          name="accountId"
                          type="number"
                          min="1"
                          step="1"
                          required
                          defaultValue={data.account?.accountId ?? ""}
                          readOnly={!!data.account?.accountId}
                        />
                      </label>
                      <label>
                        Token de acesso do JRC Conversas
                        <input
                          name="token"
                          type="password"
                          required
                          autoComplete="off"
                          minLength={8}
                        />
                        <small>
                          Use o token do perfil de um administrador dessa conta.
                          A chave de API do broker é uma credencial diferente.
                        </small>
                      </label>
                      <button className="button" disabled={blocked}>
                        Vincular conta
                      </button>
                    </form>
                  </details>
                )}
              {canManage && platform && !data.account && (
                <details>
                  <summary>Criar conta para este cliente</summary>
                  {data.provisioningAvailable ? (
                    <form
                      className="integration-form"
                      onSubmit={(e) =>
                        submit(
                          e,
                          (form) =>
                            void action(
                              "/provision",
                              "POST",
                              Object.fromEntries(form),
                              "Conta criada e responsável vinculado.",
                            ),
                        )
                      }
                    >
                      <label>
                        Nome da empresa
                        <input
                          name="name"
                          defaultValue={companyName}
                          maxLength={120}
                          required
                        />
                      </label>
                      <label>
                        E-mail do responsável
                        <input
                          name="email"
                          type="email"
                          defaultValue={ownerEmail}
                          required
                        />
                      </label>
                      <label>
                        Senha inicial do JRC Conversas
                        <input
                          name="password"
                          type="password"
                          minLength={12}
                          maxLength={128}
                          autoComplete="new-password"
                          required
                        />
                        <small>
                          Use letras maiúsculas e minúsculas, número e símbolo.
                          Se o e-mail já existir no JRC Conversas, sua senha
                          atual será mantida.
                        </small>
                      </label>
                      <button className="button" disabled={blocked}>
                        Criar conta e acesso
                      </button>
                    </form>
                  ) : (
                    <p>
                      A criação automática aguarda a credencial da plataforma
                      JRC Conversas no servidor. O vínculo de uma conta
                      existente já pode ser usado.
                    </p>
                  )}
                </details>
              )}
              {data.provisioning && (
                <div className="integration-provision">
                  <strong>
                    {stages[data.provisioning.stage]} ·{" "}
                    {states[data.provisioning.state]}
                  </strong>
                  {data.provisioning.lastError && (
                    <p>
                      {errors[data.provisioning.lastError] ??
                        "Confira o cadastro no JRC Conversas antes de continuar."}
                    </p>
                  )}
                  {platform &&
                    canManage &&
                    ["PENDING", "FAILED"].includes(data.provisioning.state) && (
                      <button
                        className="button"
                        disabled={blocked}
                        onClick={() => void action("/provision/resume")}
                      >
                        Continuar cadastro
                      </button>
                    )}
                  {platform &&
                    canManage &&
                    ["UNKNOWN", "RUNNING"].includes(
                      data.provisioning.state,
                    ) && (
                      <form
                        className="integration-form"
                        onSubmit={(e) =>
                          submit(
                            e,
                            (form) =>
                              void action(
                                "/provision/reconcile",
                                "POST",
                                form.get("remoteId")
                                  ? { remoteId: Number(form.get("remoteId")) }
                                  : {},
                              ),
                          )
                        }
                      >
                        {["ACCOUNT", "USER"].includes(
                          data.provisioning.stage,
                        ) && (
                          <label>
                            ID{" "}
                            {data.provisioning.stage === "ACCOUNT"
                              ? "da conta criada"
                              : "do usuário criado"}
                            <input
                              name="remoteId"
                              type="number"
                              min="1"
                              required
                            />
                          </label>
                        )}
                        <button
                          className="button button--secondary"
                          disabled={blocked}
                        >
                          Conferir e continuar
                        </button>
                      </form>
                    )}
                </div>
              )}
            </div>
          </section>
          <section className="panel">
            <h3>2. Caixas e conexões</h3>
            <p>
              O broker recebe as mensagens do WhatsApp, entrega nesta caixa e
              encaminha as respostas públicas dos atendentes.
            </p>
            {canManage && accountReady && (
              <form
                className="integration-form integration-form--connection"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = new FormData(e.currentTarget),
                    chosen = sources.find((s) => s.id === source);
                  if (!chosen) return;
                  void action(
                    "/connections",
                    "POST",
                    {
                      [chosen.kind === "instance" ? "instanceId" : "channelId"]:
                        chosen.id,
                      name: String(form.get("name")),
                      ...(selectedInbox
                        ? { inboxId: Number(selectedInbox) }
                        : {}),
                      ...(selected?.hasWebhook
                        ? {
                            replaceExistingWebhook:
                              form.get("replace") === "on",
                          }
                        : {}),
                    },
                    "Caixa configurada. Faça um teste real de envio e resposta.",
                  );
                }}
              >
                <label>
                  Conexão WhatsApp
                  <select
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                    required
                  >
                    <option value="">Selecione uma conexão</option>
                    {sources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} · {s.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Destino
                  <select
                    value={selectedInbox}
                    onChange={(e) => setSelectedInbox(e.target.value)}
                  >
                    <option value="">Criar nova caixa API</option>
                    {inboxes.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name} · Caixa {i.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Nome da caixa
                  <input
                    name="name"
                    required
                    maxLength={120}
                    placeholder="Ex.: Comercial"
                  />
                </label>
                {selected?.hasWebhook && (
                  <label className="integration-check">
                    <input type="checkbox" name="replace" required /> Substituir
                    o webhook atual desta caixa pelo broker JRC.
                  </label>
                )}
                <button className="button" disabled={blocked || !source}>
                  Conectar caixa
                </button>
              </form>
            )}
            {accountReady && canManage && !sources.length && (
              <p>
                Não há novas conexões disponíveis. Cadastre ou conecte um
                WhatsApp no broker.
              </p>
            )}
            {!data.connections.length && (
              <p>Nenhuma caixa vinculada nesta empresa.</p>
            )}
            <div className="integration-connections">
              {data.connections.map((c) => (
                <article key={c.id}>
                  <header>
                    <div>
                      <strong>{c.name}</strong>
                      <small>
                        {c.inboxId ? `Caixa ${c.inboxId}` : "Caixa pendente"}
                      </small>
                    </div>
                    <span
                      className={
                        "integration-state integration-state--" +
                        c.status.toLowerCase()
                      }
                    >
                      {states[c.status]}
                    </span>
                  </header>
                  {canManage && data.controlEnabled && <label>ID da integração
                    <input readOnly value={c.id} onFocus={event => event.currentTarget.select()} />
                  </label>}
                  <label>
                    Webhook desta caixa
                    <div className="integration-copy">
                      <input readOnly value={c.webhookUrl} />
                      <button
                        className="button button--secondary"
                        type="button"
                        onClick={() =>
                          void navigator.clipboard
                            .writeText(c.webhookUrl)
                            .then(() => setNotice("Webhook copiado."))
                            .catch(() =>
                              setError(
                                "Selecione e copie o endereço do webhook.",
                              ),
                            )
                        }
                      >
                        Copiar
                      </button>
                    </div>
                  </label>
                  {c.lastError && (
                    <p>
                      {errors[c.lastError] ??
                        "Confira as pendências de configuração desta caixa."}
                    </p>
                  )}
                  {canManage && (
                    <div className="integration-actions">
                      {c.status === "FAILED" && (
                        <form
                          onSubmit={(event) => {
                            event.preventDefault();
                            const form = new FormData(event.currentTarget);
                            void action(
                              "/connections/" + c.id + "/retry",
                              "POST",
                              {
                                replaceExistingWebhook:
                                  form.get("replace") === "on",
                              },
                            );
                          }}
                        >
                          {c.lastError ===
                            "CHATWOOT_WEBHOOK_REPLACEMENT_REQUIRED" && (
                            <label className="integration-check">
                              <input type="checkbox" name="replace" required />{" "}
                              Confirmo a substituição do webhook desta caixa.
                            </label>
                          )}
                          <button className="button" disabled={blocked}>
                            Repetir configuração
                          </button>
                        </form>
                      )}
                      {["READY", "DISABLED"].includes(c.status) ? (
                        <button
                          className="button button--secondary"
                          disabled={blocked}
                          onClick={() =>
                            void action("/connections/" + c.id, "PATCH", {
                              enabled: c.status === "DISABLED",
                            })
                          }
                        >
                          {c.status === "READY"
                            ? "Pausar integração"
                            : "Retomar integração"}
                        </button>
                      ) : (
                        <button
                          className="button button--secondary"
                          disabled={blocked}
                          onClick={() =>
                            void action("/connections/" + c.id + "/reconcile")
                          }
                        >
                          Conferir caixa
                        </button>
                      )}
                    </div>
                  )}
                  {canManage &&
                    c.inboxId &&
                    ["READY", "DISABLED"].includes(c.status) && (
                      <InboxAgents
                        key={c.id}
                        request={request}
                        connectionId={c.id}
                        disabled={blocked}
                      />
                    )}
                </article>
              ))}
            </div>
          </section>
          <section className="panel">
            <h3>3. Entregas e acompanhamento</h3>
            <p>
              Últimas 100 tarefas. Uma confirmação pendente precisa ser
              conferida antes de repetir a entrega.
            </p>
            <label>
              Buscar por ID de mensagem ou tarefa
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cole o identificador"
              />
            </label>
            {canManage &&
              jobs.some((j) => ["FAILED", "UNKNOWN"].includes(j.status)) && (
                <label>
                  Motivo do reprocessamento
                  <input
                    value={reason}
                    minLength={5}
                    maxLength={500}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
              )}
            <div className="integration-table">
              <table>
                <thead>
                  <tr>
                    <th>Tarefa</th>
                    <th>Fluxo</th>
                    <th>Situação</th>
                    <th>Tentativas</th>
                    <th>Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.map((j) => (
                    <tr key={j.id}>
                      <td>
                        <code>{j.id}</code>
                        {j.messageId && <small>Mensagem {j.messageId}</small>}
                      </td>
                      <td>
                        {j.kind === "CHATWOOT_REPLY"
                          ? "Atendente → WhatsApp"
                          : "WhatsApp → JRC Conversas"}
                      </td>
                      <td>
                        {states[j.status]}
                        {j.lastError && (
                          <small>{errors[j.lastError] ?? j.lastError}</small>
                        )}
                      </td>
                      <td>{j.attempts}</td>
                      <td>
                        {canManage && j.status === "FAILED" ? (
                          <button
                            className="button button--secondary"
                            disabled={blocked || reason.trim().length < 5}
                            onClick={() =>
                              void action("/jobs/" + j.id + "/retry", "POST", {
                                reason,
                              })
                            }
                          >
                            Reprocessar
                          </button>
                        ) : canManage && j.status === "UNKNOWN" ? (
                          <form
                            className="integration-form"
                            onSubmit={(event) => {
                              event.preventDefault();
                              const form = new FormData(event.currentTarget);
                              void action(
                                "/jobs/" + j.id + "/reconcile",
                                "POST",
                                {
                                  reason,
                                  ...(form.get("remoteId")
                                    ? { remoteId: Number(form.get("remoteId")) }
                                    : {}),
                                },
                              );
                            }}
                          >
                            {["CREATE_CONVERSATION", "SEND_MESSAGE"].includes(
                              j.operation ?? "",
                            ) && (
                              <label>
                                {j.operation === "CREATE_CONVERSATION"
                                  ? "ID da conversa"
                                  : "ID da mensagem (opcional)"}
                                <input
                                  name="remoteId"
                                  type="number"
                                  min="1"
                                  required={
                                    j.operation === "CREATE_CONVERSATION"
                                  }
                                />
                              </label>
                            )}
                            <button
                              className="button button--secondary"
                              disabled={blocked || reason.trim().length < 5}
                            >
                              Conferir entrega
                            </button>
                          </form>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!queue.length && <p>Nenhuma tarefa encontrada.</p>}
          </section>
        </>
      )}
    </div>
  );
}

function InboxAgents({
  request,
  connectionId,
  disabled,
}: {
  request: IntegrationRequest;
  connectionId: string;
  disabled: boolean;
}) {
  const [users, setUsers] = useState<
      { id: number; name: string; email: string; assigned: boolean }[] | null
    >(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function load() {
    setBusy(true);
    setError("");
    try {
      const result = (await request(
        "/connections/" + connectionId + "/agents",
      )) as { data: NonNullable<typeof users> };
      if (live.current) setUsers(result.data);
    } catch (e) {
      if (live.current) setError(integrationError(e));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function assign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ids = new FormData(event.currentTarget).getAll("agent").map(Number);
    if (!ids.length || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = (await request(
        "/connections/" + connectionId + "/agents",
        "POST",
        { userIds: ids },
      )) as { data: NonNullable<typeof users> };
      if (live.current) setUsers(result.data);
    } catch (e) {
      if (live.current) setError(integrationError(e));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  return (
    <details>
      <summary>Atendentes desta caixa</summary>
      <p>Vincule os atendentes que devem receber as conversas desta conexão.</p>
      <button
        type="button"
        className="button button--secondary"
        disabled={disabled || busy}
        onClick={() => void load()}
      >
        Consultar atendentes
      </button>
      {error && <p role="alert">{error}</p>}
      {users && (
        <form onSubmit={(e) => void assign(e)}>
          {users.map((user) => (
            <label className="integration-check" key={user.id}>
              <input
                type="checkbox"
                name="agent"
                value={user.id}
                disabled={user.assigned || busy || disabled}
                checked={user.assigned ? true : undefined}
              />
              {user.name} · {user.email}
              {user.assigned ? " · Vinculado" : ""}
            </label>
          ))}
          {!users.length ? (
            <p>Nenhum atendente cadastrado nesta conta.</p>
          ) : (
            <button className="button" disabled={busy || disabled}>
              Adicionar selecionados
            </button>
          )}
        </form>
      )}
    </details>
  );
}
