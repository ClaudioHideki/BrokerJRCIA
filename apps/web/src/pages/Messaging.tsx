import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import {
  ConversationsResponseSchema,
  MessagesResponseSchema,
  MessagingChannelsResponseSchema,
  TemplatesResponseSchema,
  type ConversationView,
  type MessageView,
  type MessagingChannelView,
  type TemplateView,
} from "@jrc/contracts";

import { ApiClientError, type ApiClient } from "../api/client.js";
import { useApiClient, useSession } from "../auth/SessionProvider.js";

function safeError(error: unknown, fallback: string) {
  const apiError = error instanceof ApiClientError ? error : null;
  return {
    text: apiError?.message ?? fallback,
    ...(apiError?.requestId ? { requestId: apiError.requestId } : {}),
  };
}

function invalidResponse(): ApiClientError {
  return new ApiClientError("O serviço retornou uma resposta inválida.", 502);
}

async function loadChannels(client: ApiClient, signal: AbortSignal) {
  const parsed = MessagingChannelsResponseSchema.safeParse(
    await client.request<unknown>("/v1/messaging/channels", { signal }),
  );
  if (!parsed.success) throw invalidResponse();
  return parsed.data.data;
}

async function loadTemplates(
  client: ApiClient,
  channelId: string,
  signal: AbortSignal,
) {
  const parsed = TemplatesResponseSchema.safeParse(
    await client.request<unknown>(
      `/v1/messaging/channels/${encodeURIComponent(channelId)}/templates`,
      { signal },
    ),
  );
  if (!parsed.success) throw invalidResponse();
  return parsed.data.data;
}

async function loadConversations(
  client: ApiClient,
  channelId: string,
  signal: AbortSignal,
) {
  const parsed = ConversationsResponseSchema.safeParse(
    await client.request<unknown>(
      `/v1/messaging/channels/${encodeURIComponent(channelId)}/conversations`,
      { signal },
    ),
  );
  if (!parsed.success) throw invalidResponse();
  return parsed.data.data;
}

async function loadMessages(
  client: ApiClient,
  conversationId: string,
  signal: AbortSignal,
) {
  const parsed = MessagesResponseSchema.safeParse(
    await client.request<unknown>(
      `/v1/messaging/conversations/${encodeURIComponent(conversationId)}/messages`,
      { signal },
    ),
  );
  if (!parsed.success) throw invalidResponse();
  return parsed.data.data;
}

function directionLabel(direction: MessageView["direction"]): string {
  return direction === "INCOMING" ? "Entrada" : "Saída";
}

function modeLabel(mode: ConversationView["mode"]): string {
  return mode === "HUMAN" ? "Atendimento humano" : "Bot";
}

export function MessagingPage() {
  const client = useApiClient();
  const { session, tenantRevision } = useSession();
  const organizationId = session?.activeOrganization.id ?? null;
  const canMutate = Boolean(
    session && session.activeOrganization.role !== "VIEWER",
  );
  const canConfigureAutomation =
    session?.activeOrganization.role === "OWNER" ||
    session?.activeOrganization.role === "ADMIN";
  const tenantGeneration = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const [channels, setChannels] = useState<MessagingChannelView[]>([]);
  const [channelId, setChannelId] = useState("");
  const [templates, setTemplates] = useState<TemplateView[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [templateVariables, setTemplateVariables] = useState<string[]>([]);
  const [conversations, setConversations] = useState<ConversationView[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [loadingChannels, setLoadingChannels] = useState(true);
  const [loadingChannel, setLoadingChannel] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const sendLock = useRef(false),
    pendingSend = useRef<{ payload: string; key: string } | null>(null);
  const [changingMode, setChangingMode] = useState(false);
  const [messageRevision, setMessageRevision] = useState(0);
  const [error, setError] = useState<{
    text: string;
    requestId?: string;
  } | null>(null);

  const abortPending = useCallback(() => {
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
  }, []);

  const resetState = useCallback(() => {
    setChannels([]);
    setChannelId("");
    setTemplates([]);
    setTemplateId("");
    setTemplateVariables([]);
    setConversations([]);
    setConversationId("");
    setMessages([]);
    setLoadingChannel(false);
    setLoadingMessages(false);
    setSending(false);
    setDraft("");
    pendingSend.current = null;
    sendLock.current = false;
    setChangingMode(false);
    setError(null);
  }, []);

  useEffect(() => {
    if (organizationId === null) {
      abortPending();
      resetState();
      setLoadingChannels(true);
      return undefined;
    }
    const generation = ++tenantGeneration.current;
    abortPending();
    const controller = new AbortController();
    controllers.current.add(controller);
    resetState();
    setLoadingChannels(true);
    void loadChannels(client, controller.signal)
      .then((data) => {
        if (
          generation !== tenantGeneration.current ||
          controller.signal.aborted
        )
          return;
        setChannels(data);
        setChannelId(data[0]?.id ?? "");
      })
      .catch((caught: unknown) => {
        if (
          generation === tenantGeneration.current &&
          !controller.signal.aborted
        ) {
          setError(
            safeError(caught, "Não foi possível carregar as caixas WhatsApp."),
          );
        }
      })
      .finally(() => {
        controllers.current.delete(controller);
        if (
          generation === tenantGeneration.current &&
          !controller.signal.aborted
        ) {
          setLoadingChannels(false);
        }
      });

    const unregister = client.registerTenantPurge(() => {
      tenantGeneration.current += 1;
      abortPending();
      resetState();
      setLoadingChannels(false);
    });
    return () => {
      tenantGeneration.current += 1;
      controller.abort();
      controllers.current.delete(controller);
      unregister();
    };
  }, [abortPending, client, organizationId, resetState, tenantRevision]);

  useEffect(() => {
    if (channelId === "") return;
    const generation = tenantGeneration.current;
    const controller = new AbortController();
    controllers.current.add(controller);
    setLoadingChannel(true);
    setTemplates([]);
    setTemplateId("");
    setTemplateVariables([]);
    setConversations([]);
    setConversationId("");
    setMessages([]);
    setError(null);
    void Promise.all([
      channels.find(channel=>channel.id===channelId)?.provider === "META" ? loadTemplates(client, channelId, controller.signal) : Promise.resolve([]),
      loadConversations(client, channelId, controller.signal),
    ])
      .then(([nextTemplates, nextConversations]) => {
        if (
          generation !== tenantGeneration.current ||
          controller.signal.aborted
        )
          return;
        setTemplates(nextTemplates);
        const firstTemplate = nextTemplates.find(
          (template) =>
            template.status === "APPROVED" &&
            template.bodyVariableCount !== null,
        );
        setTemplateId(firstTemplate?.id ?? "");
        setTemplateVariables(
          Array(firstTemplate?.bodyVariableCount ?? 0).fill(""),
        );
        setConversations(nextConversations);
        setConversationId(nextConversations[0]?.id ?? "");
      })
      .catch((caught: unknown) => {
        if (
          generation === tenantGeneration.current &&
          !controller.signal.aborted
        ) {
          setError(
            safeError(caught, "Não foi possível carregar os dados do canal."),
          );
        }
      })
      .finally(() => {
        controllers.current.delete(controller);
        if (
          generation === tenantGeneration.current &&
          !controller.signal.aborted
        ) {
          setLoadingChannel(false);
        }
      });
    return () => {
      controller.abort();
      controllers.current.delete(controller);
    };
  }, [channelId, client]);

  useEffect(() => {
    if (conversationId === "") return;
    const generation = tenantGeneration.current;
    const controller = new AbortController();
    controllers.current.add(controller);
    setLoadingMessages(true);
    setMessages([]);
    setError(null);
    void loadMessages(client, conversationId, controller.signal)
      .then((data) => {
        if (
          generation !== tenantGeneration.current ||
          controller.signal.aborted
        )
          return;
        setMessages(data);
      })
      .catch((caught: unknown) => {
        if (
          generation === tenantGeneration.current &&
          !controller.signal.aborted
        ) {
          setError(safeError(caught, "Não foi possível carregar o histórico."));
        }
      })
      .finally(() => {
        controllers.current.delete(controller);
        if (
          generation === tenantGeneration.current &&
          !controller.signal.aborted
        ) {
          setLoadingMessages(false);
        }
      });
    return () => {
      controller.abort();
      controllers.current.delete(controller);
    };
  }, [client, conversationId, messageRevision]);

  const selectedConversation =
    conversations.find((item) => item.id === conversationId) ?? null;
  const selectedChannel =
    channels.find((item) => item.id === channelId) ?? null;
  const sendableTemplates = templates.filter(
    (template) =>
      template.status === "APPROVED" && template.bodyVariableCount !== null,
  );
  const selectedTemplate =
    sendableTemplates.find((template) => template.id === templateId) ?? null;
  const variablesAreValid =
    selectedTemplate !== null &&
    templateVariables.length === selectedTemplate.bodyVariableCount &&
    templateVariables.every(
      (value) => value.length > 0 && value.length <= 1_024,
    );

  function selectTemplate(nextTemplateId: string) {
    const nextTemplate = sendableTemplates.find(
      (template) => template.id === nextTemplateId,
    );
    setTemplateId(nextTemplateId);
    setTemplateVariables(Array(nextTemplate?.bodyVariableCount ?? 0).fill(""));
  }

  async function sendTemplate(event: FormEvent) {
    event.preventDefault();
    if (
      !canMutate ||
      !selectedConversation ||
      !selectedTemplate ||
      !variablesAreValid ||
      sendLock.current
    )
      return;
    sendLock.current = true;
    const generation = tenantGeneration.current;
    setSending(true);
    setError(null);
    try {
      const payload = JSON.stringify({
        conversationId: selectedConversation.id,
        name: selectedTemplate.name,
        language: selectedTemplate.language,
        variables: templateVariables,
      });
      if (pendingSend.current?.payload !== payload)
        pendingSend.current = { payload, key: crypto.randomUUID() };
      await client.request(
        `/v1/messaging/channels/${encodeURIComponent(channelId)}/messages`,
        {
          method: "POST",
          headers: { "Idempotency-Key": pendingSend.current.key },
          body: payload,
        },
      );
      if (generation === tenantGeneration.current) {
        pendingSend.current = null;
        setMessageRevision((current) => current + 1);
      }
    } catch (caught) {
      if (generation === tenantGeneration.current) {
        setError(safeError(caught, "Não foi possível enviar o template."));
      }
    } finally {
      if (generation === tenantGeneration.current) {
        sendLock.current = false;
        setSending(false);
      }
    }
  }
  async function sendText(event: FormEvent) {
    event.preventDefault();
    if (
      !canMutate ||
      !selectedConversation ||
      !draft.trim() ||
      sendLock.current
    )
      return;
    sendLock.current = true;
    const generation = tenantGeneration.current;
    setSending(true);
    setError(null);
    const payload = JSON.stringify({
      conversationId: selectedConversation.id,
      text: draft.trim(),
    });
    if (pendingSend.current?.payload !== payload)
      pendingSend.current = { payload, key: crypto.randomUUID() };
    try {
      await client.request(
        `/v1/messaging/channels/${encodeURIComponent(channelId)}/text`,
        {
          method: "POST",
          headers: { "Idempotency-Key": pendingSend.current.key },
          body: payload,
        },
      );
      if (generation === tenantGeneration.current) {
        setDraft("");
        pendingSend.current = null;
        setMessageRevision((v) => v + 1);
        setConversations((rows) =>
          rows.map((row) =>
            row.id === selectedConversation.id
              ? { ...row, mode: "HUMAN" }
              : row,
          ),
        );
      }
    } catch (caught) {
      if (generation === tenantGeneration.current)
        setError(safeError(caught, "Não foi possível enfileirar a mensagem."));
    } finally {
      if (generation === tenantGeneration.current) {
        sendLock.current = false;
        setSending(false);
      }
    }
  }
  async function downloadMedia(message: MessageView) {
    if (!message.media) return;
    const generation = tenantGeneration.current;
    setError(null);
    try {
      const file = await client.request<Blob>(
        `/v1/messaging/media/${message.media.id}`,
        { responseType: "blob" },
      );
      if (generation !== tenantGeneration.current) return;
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = message.media.fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (caught) {
      if (generation === tenantGeneration.current)
        setError(safeError(caught, "O arquivo ainda não está disponível."));
    }
  }
  async function retryMessage(id: string) {
    const generation = tenantGeneration.current;
    try {
      await client.request(`/v1/messaging/messages/${id}/retry`, {
        method: "POST",
        body: JSON.stringify({
          reason: "Administrador solicitou nova tentativa após revisar a falha",
        }),
      });
      if (generation === tenantGeneration.current)
        setMessageRevision((v) => v + 1);
    } catch (e) {
      if (generation === tenantGeneration.current)
        setError(safeError(e, "Não foi possível repetir esta mensagem."));
    }
  }

  async function changeMode() {
    if (!canMutate || !selectedConversation) return;
    const generation = tenantGeneration.current;
    const mode = selectedConversation.mode === "BOT" ? "HUMAN" : "BOT";
    setChangingMode(true);
    setError(null);
    try {
      await client.request(
        `/v1/messaging/conversations/${encodeURIComponent(selectedConversation.id)}/mode`,
        { method: "PATCH", body: JSON.stringify({ mode }) },
      );
      if (generation !== tenantGeneration.current) return;
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === selectedConversation.id
            ? { ...conversation, mode }
            : conversation,
        ),
      );
    } catch (caught) {
      if (generation === tenantGeneration.current) {
        setError(
          safeError(caught, "Não foi possível alterar o modo da conversa."),
        );
      }
    } finally {
      if (generation === tenantGeneration.current) setChangingMode(false);
    }
  }

  return (
    <section aria-labelledby="messaging-title">
      <div className="page-heading">
        <div>
          <p className="eyebrow">WhatsApp JRC</p>
          <h1 id="messaging-title">Conversas</h1>
          <p>Consulte o histórico, os anexos e as entregas da empresa ativa.</p>
        </div>
      </div>
      {!canMutate && session ? (
        <p className="notice">Seu acesso é somente leitura.</p>
      ) : null}
      {error ? (
        <div className="notice notice--error" role="alert">
          {error.text}
          {error.requestId ? (
            <small>Solicitação: {error.requestId}</small>
          ) : null}
        </div>
      ) : null}
      {loadingChannels ? (
        <div className="state-card" aria-busy="true">
          Carregando canais…
        </div>
      ) : null}
      {!loadingChannels && channels.length === 0 ? (
        <div className="state-card">
          <h2>Nenhum canal configurado</h2>
          <p>
            Vincule um WhatsApp por QR Code ou uma conta oficial para começar.
          </p>
        </div>
      ) : null}
      {channels.length > 0 ? (
        <>
          <div className="panel form-grid">
            <label htmlFor="messaging-channel">Canal WhatsApp</label>
            <select
              id="messaging-channel"
              value={channelId}
              onChange={(event) => setChannelId(event.target.value)}
            >
              {channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.provider === "BAILEYS"
                    ? "WhatsApp QR Code"
                    : "WhatsApp oficial"}{" "}
                  · {channel.id}
                </option>
              ))}
            </select>
            <label htmlFor="messaging-conversation">Conversa</label>
            <select
              id="messaging-conversation"
              value={conversationId}
              disabled={loadingChannel || conversations.length === 0}
              onChange={(event) => setConversationId(event.target.value)}
            >
              {conversations.map((conversation) => (
                <option key={conversation.id} value={conversation.id}>
                  {conversation.contactId}
                </option>
              ))}
            </select>
          </div>
          <section className="panel" aria-labelledby="automation-title">
            <h2 id="automation-title">Automação JRC</h2>
            <p>Crie ou importe seu chatbot em Automações. Publique uma versão e ative-a na caixa WhatsApp desejada.</p>
            <a className="button button--secondary" href="/automations">Gerenciar automações</a>{' '}
            <a href="/channels">Gerenciar caixas de entrada</a>
          </section>
          {loadingChannel ? (
            <div className="state-card" aria-busy="true">
              Carregando canal…
            </div>
          ) : null}
          {!loadingChannel ? (
            <div className="messaging-grid">
              {selectedChannel?.provider === "META" ? <section className="panel" aria-labelledby="templates-title">
                <h2 id="templates-title">Templates</h2>
                {templates.length === 0 ? (
                  <p>Nenhum template sincronizado.</p>
                ) : (
                  <ul>
                    {templates.map((template) => (
                      <li key={template.id}>
                        <strong>{template.name}</strong>{" "}
                        <span>{template.language}</span>{" "}
                        <span>{template.category}</span>{" "}
                        <span>{template.status}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {canMutate ? (
                  <form onSubmit={(event) => void sendTemplate(event)}>
                    <label htmlFor="approved-template">Modelo aprovado</label>
                    <select
                      id="approved-template"
                      value={templateId}
                      disabled={sendableTemplates.length === 0 || sending}
                      onChange={(event) => selectTemplate(event.target.value)}
                    >
                      {sendableTemplates.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name} · {template.language}
                        </option>
                      ))}
                    </select>
                    {sendableTemplates.length === 0 ? (
                      <p>Nenhum template aprovado compatível disponível.</p>
                    ) : null}
                    {templateVariables.map((value, index) => {
                      const position = index + 1;
                      const inputId = `template-variable-${position}`;
                      return (
                        <div key={inputId}>
                          <label htmlFor={inputId}>Variável {position}</label>
                          <input
                            id={inputId}
                            maxLength={1_024}
                            required
                            type="text"
                            value={value}
                            onChange={(event) =>
                              setTemplateVariables((current) =>
                                current.map((item, itemIndex) =>
                                  itemIndex === index
                                    ? event.target.value
                                    : item,
                                ),
                              )
                            }
                          />
                        </div>
                      );
                    })}
                    <button
                      className="button button--primary"
                      type="submit"
                      disabled={
                        !selectedConversation || !variablesAreValid || sending
                      }
                    >
                      {sending ? "Enviando…" : "Enviar template"}
                    </button>
                  </form>
                ) : null}
              </section> : null}
              <section className="panel" aria-labelledby="history-title">
                <h2 id="history-title">Histórico</h2>
                {selectedConversation ? (
                  <>
                    <p>Modo: {modeLabel(selectedConversation.mode)}</p>
                    {canMutate ? (
                      <button
                        className="button button--ghost"
                        type="button"
                        disabled={changingMode}
                        onClick={() => void changeMode()}
                      >
                        {selectedConversation.mode === "BOT"
                          ? "Assumir atendimento"
                          : "Retomar bot"}
                      </button>
                    ) : null}
                  </>
                ) : (
                  <p>Nenhuma conversa disponível.</p>
                )}
                {loadingMessages ? (
                  <p aria-busy="true">Carregando histórico…</p>
                ) : null}
                {!loadingMessages &&
                selectedConversation &&
                messages.length === 0 ? (
                  <p>Nenhuma mensagem.</p>
                ) : null}
                {messages.length > 0 ? (
                  <ol>
                    {messages.map((message) => (
                      <li key={message.id} data-message-id={message.id}>
                        <small>
                          {directionLabel(message.direction)} · {message.state}
                        </small>
                        <p>{message.text}</p>
                        {message.media ? (
                          <button
                            className="button button--ghost"
                            type="button"
                            onClick={() => void downloadMedia(message)}
                          >
                            Baixar anexo
                          </button>
                        ) : null}
                        {message.errorCode ? (
                          <small>Motivo: {message.errorCode}</small>
                        ) : null}
                        {canConfigureAutomation && message.retrySafe ? (
                          <button
                            type="button"
                            className="button button--secondary"
                            onClick={() => void retryMessage(message.id)}
                          >
                            Tentar novamente
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                ) : null}
                <button
                  className="button button--ghost"
                  type="button"
                  disabled={!selectedConversation || loadingMessages}
                  onClick={() => setMessageRevision((v) => v + 1)}
                >
                  Atualizar histórico
                </button>
                {canMutate && selectedConversation ? (
                  <form onSubmit={(event) => void sendText(event)}>
                    <label htmlFor="reply-text">Responder</label>
                    <textarea
                      id="reply-text"
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      maxLength={4096}
                      required
                      disabled={sending}
                    />
                    {selectedChannel?.provider === "META" ? (
                      <p>
                        Texto livre fica disponível na janela de atendimento de
                        24 horas após a última mensagem do contato.
                      </p>
                    ) : null}
                    <button
                      className="button button--primary"
                      type="submit"
                      disabled={sending || !draft.trim()}
                    >
                      {sending ? "Enfileirando…" : "Enviar mensagem"}
                    </button>
                  </form>
                ) : null}
              </section>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
