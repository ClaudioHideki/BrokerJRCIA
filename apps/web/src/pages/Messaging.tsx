import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import {
  ConversationsResponseSchema,
  ConversationViewSchema,
  CreateTextTemplateRequestSchema,
  MessagesResponseSchema,
  MessagingChannelsResponseSchema,
  TemplatesResponseSchema,
  TemplateStatusResponseSchema,
  SubmittedTemplateSchema,
  type ConversationView,
  type LocalQueueItem,
  type MessageView,
  type MessagingChannelView,
  type TemplateView,
} from "@jrc/contracts";

import { ApiClientError, type ApiClient } from "../api/client.js";
import { useApiClient, useSession } from "../auth/SessionProvider.js";
import { AttendanceResumeDialog } from './AttendanceResumeDialog.js';
import {LocalAttendancePanel} from '../attendance/LocalAttendancePanel.js';
import {QrOutboundObservations} from './QrOutboundObservations.js';
import {QrDispatchAttempts} from './QrDispatchAttempts.js';

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
  const activeChannelId = useRef(channelId);
  activeChannelId.current = channelId;
  const [templates, setTemplates] = useState<TemplateView[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [templateVariables, setTemplateVariables] = useState<string[]>([]);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [newTemplateLanguage, setNewTemplateLanguage] = useState("pt_BR");
  const [newTemplateCategory, setNewTemplateCategory] = useState<"UTILITY" | "MARKETING">("UTILITY");
  const [newTemplateBody, setNewTemplateBody] = useState("");
  const [templateSubmission, setTemplateSubmission] = useState<string | null>(null);
  const [submittingTemplate, setSubmittingTemplate] = useState(false);
  const [refreshingTemplates, setRefreshingTemplates] = useState(false);
  const [checkingTemplateId, setCheckingTemplateId] = useState<string | null>(null);
  const [templateStatusNotes, setTemplateStatusNotes] = useState<Record<string, string>>({});
  const locallySubmittedTemplateIds = useRef(new Set<string>());
  const templateSubmitLock = useRef(false);
  const pendingTemplateSubmission = useRef<{ payload: string; key: string } | null>(null);
  const [conversations, setConversations] = useState<ConversationView[]>([]);
  const [conversationId, setConversationId] = useState("");
  const conversationNavigation = useRef(0);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [loadingChannels, setLoadingChannels] = useState(true);
  const [loadingChannel, setLoadingChannel] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const sendLock = useRef(false),
    pendingSend = useRef<{ payload: string; key: string } | null>(null);
  const [changingMode, setChangingMode] = useState(false);
  const [resumingConversation,setResumingConversation]=useState<string|null>(null);
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
    conversationNavigation.current += 1;
    setChannels([]);
    setChannelId("");
    setTemplates([]);
    setTemplateId("");
    setTemplateVariables([]);
    setNewTemplateName("");
    setNewTemplateLanguage("pt_BR");
    setNewTemplateCategory("UTILITY");
    setNewTemplateBody("");
    setTemplateSubmission(null);
    setSubmittingTemplate(false);
    setRefreshingTemplates(false);
    setCheckingTemplateId(null);
    setTemplateStatusNotes({});
    locallySubmittedTemplateIds.current.clear();
    templateSubmitLock.current = false;
    pendingTemplateSubmission.current = null;
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
    setResumingConversation(null);
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
    setTemplateSubmission(null);
    setTemplateStatusNotes({});
    locallySubmittedTemplateIds.current.clear();
    pendingTemplateSubmission.current = null;
    setNewTemplateName("");
    setNewTemplateBody("");
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

  function openAssignedConversation(row: LocalQueueItem) {
    const generation = tenantGeneration.current, assignedChannel = channelId;
    const navigation = ++conversationNavigation.current;
    const controller = new AbortController();
    controllers.current.add(controller);
    // Remove the previous composer immediately; never carry its draft into another conversation.
    setConversationId(""); setMessages([]); setDraft(""); pendingSend.current = null;
    setResumingConversation(null); setError(null);
    void client.request(`/v1/messaging/conversations/${encodeURIComponent(row.conversationId)}`,{signal:controller.signal}).then(raw => {
      if(controller.signal.aborted || navigation !== conversationNavigation.current || generation !== tenantGeneration.current || assignedChannel !== activeChannelId.current) return;
      const parsed=ConversationViewSchema.safeParse(raw);
      if(!parsed.success || parsed.data.id!==row.conversationId || parsed.data.channelId!==assignedChannel)
        throw new ApiClientError("A conversa assumida não está disponível nesta caixa. Atualize o canal antes de responder.",409);
      const confirmed=parsed.data;
      setConversations(data=>[...data.filter(item=>item.id!==confirmed.id),confirmed]); setConversationId(confirmed.id); setMessageRevision(value => value + 1);
    }).catch(cause => {
      if(!controller.signal.aborted && navigation === conversationNavigation.current && generation === tenantGeneration.current && assignedChannel === activeChannelId.current)
        setError(safeError(cause,"Não foi possível abrir a conversa assumida. Atualize o canal antes de responder."));
    }).finally(() => controllers.current.delete(controller));
  }
  function startAssignmentNavigation() {
    const navigation=++conversationNavigation.current,generation=tenantGeneration.current,assignedChannel=channelId;
    return ()=>navigation===conversationNavigation.current&&generation===tenantGeneration.current&&assignedChannel===activeChannelId.current;
  }
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

  async function submitTextTemplate(event: FormEvent) {
    event.preventDefault();
    if (!canConfigureAutomation || selectedChannel?.provider !== "META" || templateSubmitLock.current) return;
    const parsed = CreateTextTemplateRequestSchema.safeParse({
      name: newTemplateName.trim(), language: newTemplateLanguage.trim(),
      category: newTemplateCategory, body: newTemplateBody,
    });
    if (!parsed.success) {
      setError({ text: "Informe nome em letras minúsculas, idioma e texto fixo sem variáveis." });
      return;
    }
    templateSubmitLock.current = true;
    const generation = tenantGeneration.current;
    const submittedChannel = channelId;
    const payload = JSON.stringify(parsed.data);
    const submissionIdentity = `${submittedChannel}:${payload}`;
    if (pendingTemplateSubmission.current?.payload !== submissionIdentity)
      pendingTemplateSubmission.current = { payload: submissionIdentity, key: crypto.randomUUID() };
    setSubmittingTemplate(true);
    setTemplateSubmission(null);
    setError(null);
    try {
      const response = SubmittedTemplateSchema.safeParse(await client.request<unknown>(
        `/v1/messaging/channels/${encodeURIComponent(submittedChannel)}/templates`,
        { method: "POST", headers: { "Idempotency-Key": pendingTemplateSubmission.current.key }, body: payload },
      ));
      if (!response.success) throw invalidResponse();
      pendingTemplateSubmission.current = null;
      if (generation !== tenantGeneration.current || submittedChannel !== activeChannelId.current) return;
      setTemplateSubmission(response.data.status === "STATUS_NOT_RETURNED"
        ? `${response.data.name}: solicitação recebida pela Meta; status ainda não confirmado. Atualize a lista para acompanhar.`
        : `${response.data.name}: ${response.data.status}. Atualize a lista para acompanhar.`);
      setTemplates(current => current.some(item => item.id === response.data.id) ? current : [
        ...current, { ...response.data, bodyVariableCount: 0 },
      ]);
      locallySubmittedTemplateIds.current.add(response.data.id);
      setNewTemplateName("");
      setNewTemplateBody("");
    } catch (caught) {
      if (generation !== tenantGeneration.current || submittedChannel !== activeChannelId.current) return;
      const apiError = caught instanceof ApiClientError ? caught : null;
      const fallback = apiError?.code === "META_TEMPLATE_REJECTED"
        ? "A Meta recusou o modelo. Revise o conteúdo e a categoria."
        : apiError?.code === "META_TEMPLATE_NAME_CONFLICT" || apiError?.code === "IDEMPOTENCY_CONFLICT"
          ? "Já existe uma solicitação com este nome ou chave e outro conteúdo. Use outro nome ou revise o texto."
        : "A submissão não pôde ser confirmada. Atualize a lista antes de tentar novamente para evitar duplicação.";
      setError({ text: fallback, ...(apiError?.requestId ? { requestId: apiError.requestId } : {}) });
    } finally {
      if (generation === tenantGeneration.current) {
        templateSubmitLock.current = false;
        setSubmittingTemplate(false);
      }
    }
  }

  async function refreshTemplates() {
    if (selectedChannel?.provider !== "META" || refreshingTemplates) return;
    const generation = tenantGeneration.current;
    const requestedChannel = channelId;
    const controller = new AbortController();
    controllers.current.add(controller);
    setRefreshingTemplates(true);
    try {
      const data = await loadTemplates(client, requestedChannel, controller.signal);
      if (generation === tenantGeneration.current && requestedChannel === activeChannelId.current && !controller.signal.aborted) {
        const observedIds = new Set(data.map(item => item.id));
        for (const id of observedIds) locallySubmittedTemplateIds.current.delete(id);
        setTemplates(current => [...data, ...current.filter(item => locallySubmittedTemplateIds.current.has(item.id) && !observedIds.has(item.id))
          .map(item => ({ ...item, status: "STATUS_NOT_RETURNED" }))]);
        setError(null);
      }
    } catch (caught) {
      if (generation === tenantGeneration.current && requestedChannel === activeChannelId.current && !controller.signal.aborted)
        setError(safeError(caught, "Não foi possível consultar o status dos templates."));
    } finally {
      controllers.current.delete(controller);
      if (generation === tenantGeneration.current) setRefreshingTemplates(false);
    }
  }

  async function checkTemplateStatus(template: TemplateView) {
    if (selectedChannel?.provider !== "META" || checkingTemplateId !== null) return;
    const generation = tenantGeneration.current;
    const requestedChannel = channelId;
    const controller = new AbortController();
    controllers.current.add(controller);
    setCheckingTemplateId(template.id);
    try {
      const result = TemplateStatusResponseSchema.safeParse(await client.request<unknown>(
        `/v1/messaging/channels/${encodeURIComponent(requestedChannel)}/templates/${encodeURIComponent(template.id)}/status`,
        { signal: controller.signal },
      ));
      if (!result.success) throw invalidResponse();
      if (generation !== tenantGeneration.current || requestedChannel !== activeChannelId.current || controller.signal.aborted) return;
      if (result.data.observation === "OBSERVED") {
        const observedTemplate = result.data.template;
        locallySubmittedTemplateIds.current.delete(template.id);
        setTemplates(current => current.map(item => item.id === template.id ? observedTemplate : item));
        setTemplateStatusNotes(current => ({ ...current, [template.id]: "Status consultado na Meta para esta WABA." }));
      } else {
        setTemplates(current => current.map(item => item.id === template.id ? { ...item, status: "STATUS_NOT_RETURNED" } : item));
        setTemplateStatusNotes(current => ({ ...current, [template.id]: "Este ID ainda não aparece na WABA nesta consulta. Isso não significa rejeição." }));
      }
      setError(null);
    } catch (caught) {
      if (generation === tenantGeneration.current && requestedChannel === activeChannelId.current && !controller.signal.aborted)
        setError(safeError(caught, "Não foi possível consultar o status deste template."));
    } finally {
      controllers.current.delete(controller);
      if (generation === tenantGeneration.current) setCheckingTemplateId(null);
    }
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
        if(caught instanceof ApiClientError&&caught.code==='ATTENDANCE_RESUME_REQUIRED'&&canConfigureAutomation){setResumingConversation(selectedConversation.id);return;}
        if(caught instanceof ApiClientError&&caught.code==='ATTENDANCE_RESUME_REQUIRED'){setError({text:'Um administrador precisa confirmar a retomada desta automação.'});return;}
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
              onChange={(event) => {if(event.target.value===channelId)return;conversationNavigation.current+=1;setChannelId(event.target.value);setConversationId('');setDraft('');pendingSend.current=null;}}
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
              onChange={(event) => {conversationNavigation.current+=1;setConversationId(event.target.value);setDraft('');pendingSend.current=null;}}
            >
              {conversations.map((conversation) => (
                <option key={conversation.id} value={conversation.id}>
                  {conversation.contactId} · Conversa {conversation.id}
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
          {!loadingChannel&&session&&organizationId&&channelId&&<LocalAttendancePanel key={`${organizationId}:${tenantRevision}:${channelId}`} client={client} organizationId={organizationId} channelId={channelId} actorId={session.user.id} role={session.activeOrganization.role} onAssignmentStart={startAssignmentNavigation} onAssigned={openAssignedConversation}/>}
          {loadingChannel ? (
            <div className="state-card" aria-busy="true">
              Carregando canal…
            </div>
          ) : null}
          {!loadingChannel ? (
            <div className="messaging-grid">
              {selectedChannel?.provider === "META" ? <section className="panel" aria-labelledby="templates-title">
                <h2 id="templates-title">Templates</h2>
                <button type="button" className="button button--secondary" disabled={refreshingTemplates}
                  onClick={() => void refreshTemplates()}>
                  {refreshingTemplates ? "Consultando…" : "Atualizar status dos templates"}
                </button>
                {templateSubmission ? <p role="status">{templateSubmission}</p> : null}
                {templates.length === 0 ? (
                  <p>Nenhum template sincronizado.</p>
                ) : (
                  <ul>
                    {templates.map((template) => (
                      <li key={template.id}>
                        <strong>{template.name}</strong>{" "}
                        <span>{template.language}</span>{" "}
                        <span>{template.category}</span>{" "}
                        <span>{template.status === "STATUS_NOT_RETURNED" ? "Aguardando consulta" : template.status}</span>
                        {templateStatusNotes[template.id] ? <small>{templateStatusNotes[template.id]}</small> : null}
                        <button type="button" className="button button--ghost" disabled={checkingTemplateId !== null}
                          aria-label={`Consultar status de ${template.name}`} onClick={() => void checkTemplateStatus(template)}>
                          {checkingTemplateId === template.id ? "Consultando…" : "Consultar status"}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {canConfigureAutomation ? (
                  <form onSubmit={(event) => void submitTextTemplate(event)}>
                    <h3>Criar template de texto</h3>
                    <p>O envio solicita análise da Meta. O template só pode ser usado após aprovação.</p>
                    <label htmlFor="new-template-name">Nome do novo template</label>
                    <input id="new-template-name" type="text" required maxLength={512} pattern="[a-z0-9_]+"
                      value={newTemplateName} onChange={event => setNewTemplateName(event.target.value)} />
                    <label htmlFor="new-template-language">Idioma do novo template</label>
                    <input id="new-template-language" type="text" required maxLength={6}
                      value={newTemplateLanguage} onChange={event => setNewTemplateLanguage(event.target.value)} />
                    <label htmlFor="new-template-category">Categoria do novo template</label>
                    <select id="new-template-category" value={newTemplateCategory}
                      onChange={event => setNewTemplateCategory(event.target.value as "UTILITY" | "MARKETING")}>
                      <option value="UTILITY">Utilidade</option>
                      <option value="MARKETING">Marketing</option>
                    </select>
                    <label htmlFor="new-template-body">Texto do novo template</label>
                    <textarea id="new-template-body" required maxLength={1024} value={newTemplateBody}
                      onChange={event => setNewTemplateBody(event.target.value)} />
                    <p>Esta primeira versão aceita texto fixo, sem variáveis, mídia ou botões.</p>
                    <button className="button button--primary" type="submit" disabled={submittingTemplate}>
                      {submittingTemplate ? "Enviando à Meta…" : "Enviar para aprovação da Meta"}
                    </button>
                  </form>
                ) : null}
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
                {resumingConversation===selectedConversation?.id?<AttendanceResumeDialog key={`${organizationId}:${resumingConversation}`} conversationId={resumingConversation!} client={client}
                  onClose={()=>setResumingConversation(null)} onConfirmed={()=>{
                    const generation=tenantGeneration.current,controller=new AbortController();controllers.current.add(controller);
                    void loadConversations(client,channelId,controller.signal).then(data=>{
                      if(generation!==tenantGeneration.current||controller.signal.aborted)return;
                      setConversations(data);setResumingConversation(null);setMessageRevision(v=>v+1);
                    }).catch(()=>{if(generation===tenantGeneration.current)setError(safeError(null,'A retomada foi confirmada, mas o estado atual não pôde ser carregado. Atualize a conversa.'));})
                      .finally(()=>controllers.current.delete(controller));
                  }}/>:null}
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
                      <li key={message.id} id={`message-${message.id}`} data-message-id={message.id}>
                        <small>
                          {message.source==='EXTERNAL_OBSERVED'?'Saída observada no WhatsApp':directionLabel(message.direction)} · {message.state}
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
                {selectedConversation&&selectedChannel?.provider==='BAILEYS'?<QrOutboundObservations
                  key={`${organizationId}:${tenantRevision}:${selectedConversation.id}`} client={client} conversationId={selectedConversation.id}
                  canAbandon={canConfigureAutomation} refreshRevision={messageRevision} onChanged={()=>setMessageRevision(v=>v+1)}/>:null}
                {selectedConversation&&selectedChannel?.provider==='BAILEYS'?<QrDispatchAttempts
                  key={`attempts:${organizationId}:${tenantRevision}:${selectedConversation.id}`} client={client} conversationId={selectedConversation.id}
                  canAbandon={canConfigureAutomation} refreshRevision={messageRevision} onChanged={()=>setMessageRevision(v=>v+1)}/>:null}
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
