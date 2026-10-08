import { z } from "zod";
import { createChatwootSafeFetch } from './chatwoot-safe-http.js';
import {
  MediaError,
  readMediaBytes,
  mediaKind,
  safeMediaName,
  validateMedia,
  type BinaryMedia,
} from "@jrc/providers";

const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const catalogName=z.string().max(1000);
const workingHour=z.object({day_of_week:z.number().int().min(0).max(6),closed_all_day:z.boolean(),open_all_day:z.boolean().optional(),
  open_hour:z.number().int().min(0).max(23).nullable().optional(),open_minutes:z.number().int().min(0).max(59).nullable().optional(),
  close_hour:z.number().int().min(0).max(23).nullable().optional(),close_minutes:z.number().int().min(0).max(59).nullable().optional()});
function parseCatalog<T>(schema:z.ZodType<T>,value:unknown):T {
  const result=schema.safeParse(value);
  if(!result.success)throw new ChatwootError('CHATWOOT_INVALID_RESPONSE',true);
  return result.data;
}
const dashboardApp = z.object({ id: integer, title: z.string().max(1000),
  content: z.array(z.object({ type: z.string().max(100), url: z.string().max(4096) })).max(100) });
export type DashboardApp = z.infer<typeof dashboardApp>;
export type DashboardAppPayload = { dashboard_app: { title: string; content: { type: 'frame'; url: string }[] } };
const inbox = z.object({
  id: integer,
  name: z.string(),
  channel_type: z.string(),
  webhook_url: z.string().nullable().optional(),
  secret: z.string().optional(),
});
export type ChatwootInbox = z.infer<typeof inbox>;
const flowBot = z.object({ id: integer, name: z.string(), outgoing_url: z.string().nullable().optional(),
  secret: z.string().optional(), access_token: z.union([z.string(), z.object({ token: z.string() })]).optional(),
}).transform(({ access_token, ...bot }) => ({ ...bot, token: typeof access_token === 'string' ? access_token : access_token?.token }));
export class ChatwootError extends Error {
  constructor(
    readonly code: string,
    readonly retrySafe = false,
    readonly uncertain = false,
    readonly httpStatus?: number,
  ) {
    super(code);
  }
}
type Options = {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch | undefined;
  timeoutMs?: number;
  allowLocal?: boolean | undefined;
  mediaOrigins?: readonly string[] | undefined;
};
const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
export class ChatwootClient {
  private readonly origin: string;
  private readonly fetch: typeof globalThis.fetch;
  constructor(private readonly options: Options) {
    const url = new URL(options.baseUrl);
    const local =
      options.allowLocal &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      url.protocol === "http:";
    if (
      (!local && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      !options.token ||
      /[\r\n]/u.test(options.token)
    )
      throw new Error("INVALID_CHATWOOT_ORIGIN");
    this.origin = url.origin;
    this.fetch = options.fetch ?? (local ? globalThis.fetch : createChatwootSafeFetch({
      origin: this.origin, mediaOrigins: options.mediaOrigins,
    }));
  }
  private async request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
    allowEmpty = false,
  ): Promise<unknown> {
    const safe = method !== "POST";
    let response: Response;
    try {
      response = await this.fetch(this.origin + path, {
        method,
        redirect: "error",
        headers: {
          api_access_token: this.options.token,
          Accept: "application/json",
          ...(body instanceof FormData
            ? {}
            : { "Content-Type": "application/json" }),
        },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
        ...(body === undefined
          ? {}
          : { body: body instanceof FormData ? body : JSON.stringify(body) }),
      });
    } catch {
      throw new ChatwootError(
        safe ? "CHATWOOT_UNAVAILABLE" : "CHATWOOT_OUTCOME_UNKNOWN",
        safe,
        !safe,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      const retrySafe =
        response.status === 429 || (safe && response.status >= 500);
      const uncertain =
        !safe && (response.status >= 500 || response.status === 408);
      throw new ChatwootError(
        uncertain ? "CHATWOOT_OUTCOME_UNKNOWN" : "CHATWOOT_REQUEST_REJECTED",
        retrySafe,
        uncertain,
        response.status,
      );
    }
    try {
      const reader = response.body?.getReader();
      if (!reader) { if (allowEmpty) return undefined; throw new Error(); }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 2_097_152) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(chunk.value);
      }
      if (allowEmpty && size === 0) return undefined;
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new ChatwootError("CHATWOOT_INVALID_RESPONSE", safe, !safe);
    }
  }
  private account(id: number) {
    return `/api/v1/accounts/${integer.parse(id)}`;
  }
  async verifyAccount(accountId: number): Promise<void> {
    const profile = record(await this.request("GET", "/api/v1/profile"));
    const accounts = z
      .array(z.object({ id: integer, role: z.string() }))
      .parse(profile.accounts);
    if (
      !accounts.some(
        (value) => value.id === accountId && value.role === "administrator",
      )
    )
      throw new ChatwootError("CHATWOOT_ACCOUNT_ACCESS_REQUIRED");
  }
  /** Author of messages created through this user token, verified in the exact account. */
  async centralSender(accountId: number): Promise<number> {
    const profile = record(await this.request('GET', '/api/v1/profile'));
    const accounts = z.array(z.object({ id: integer, role: z.string() })).max(10000).parse(profile.accounts);
    if (!accounts.some(account => account.id === accountId && account.role === 'administrator'))
      throw new ChatwootError('CHATWOOT_ACCOUNT_ACCESS_REQUIRED');
    return integer.parse(profile.id);
  }
  async listInboxes(accountId: number): Promise<ChatwootInbox[]> {
    const data = record(
      await this.request("GET", this.account(accountId) + "/inboxes"),
    );
    return z.array(inbox).max(10000).parse(data.payload);
  }
  async listDashboardApps(accountId: number): Promise<DashboardApp[]> {
    return z.array(dashboardApp).max(1000).parse(await this.request('GET', this.account(accountId) + '/dashboard_apps'));
  }
  async listFlowBots(accountId: number) {
    return z.array(flowBot).max(1000).parse(await this.request('GET', this.account(accountId) + '/agent_bots'));
  }
  async createFlowBot(accountId: number, name: string, outgoingUrl: string) {
    return flowBot.parse(await this.request('POST', this.account(accountId) + '/agent_bots',
      { name, description: 'Automação JRC Broker', outgoing_url: outgoingUrl, bot_type: 'webhook' }));
  }
  async inboxFlowBot(accountId: number, inboxId: number) {
    const data = parseCatalog(z.object({agent_bot:flowBot.nullable()}),
      await this.request('GET', this.account(accountId) + `/inboxes/${integer.parse(inboxId)}/agent_bot`));
    return data.agent_bot;
  }
  async setInboxFlowBot(accountId: number, inboxId: number, botId: number | null) {
    await this.request('POST', this.account(accountId) + `/inboxes/${integer.parse(inboxId)}/set_agent_bot`,
      { agent_bot: botId === null ? null : integer.parse(botId) }, true);
  }
  async flowConversation(accountId: number, conversationId: number) {
    return z.object({ id: integer, account_id: integer, inbox_id: integer, status: z.string(),
      meta: z.object({ assignee: z.object({ id: integer, type: z.string().optional() }).nullable().optional(),
        sender: z.object({ id: integer, name: z.string().optional() }) }),
    }).parse(await this.request('GET', this.account(accountId) + `/conversations/${integer.parse(conversationId)}`));
  }
  async sendFlowMessage(accountId: number, conversationId: number, text: string, deliveryId: string) {
    return integer.parse(record(await this.request('POST', this.account(accountId) + `/conversations/${integer.parse(conversationId)}/messages`,
      { content: text, message_type: 'outgoing', private: false, content_attributes: { jrc_flow_delivery_id: deliveryId } })).id);
  }
  async assignAttendanceConversation(accountId:number,conversationId:number,target:{teamId:number|null;agentId:number|null}) {
    const chosen=z.object({teamId:integer.nullable(),agentId:integer.nullable()}).strict()
      .refine(value=>(value.teamId===null)!==(value.agentId===null)).parse(target);
    // Stock Chatwoot checks the presence of assignee_id before team_id. Do not send null.
    await this.request('POST',this.account(accountId)+`/conversations/${integer.parse(conversationId)}/assignments`,
      chosen.teamId!==null?{team_id:chosen.teamId}:{assignee_id:chosen.agentId});
  }
  async handoffFlowConversation(accountId: number, conversationId: number) {
    await this.request('POST', this.account(accountId) + `/conversations/${integer.parse(conversationId)}/toggle_status`, { status: 'open' });
  }
  async createDashboardApp(accountId: number, input: DashboardAppPayload): Promise<DashboardApp> {
    return dashboardApp.parse(await this.request('POST', this.account(accountId) + '/dashboard_apps', input));
  }
  async getInbox(accountId: number, inboxId: number): Promise<ChatwootInbox> {
    return inbox.parse(
      await this.request(
        "GET",
        this.account(accountId) + `/inboxes/${integer.parse(inboxId)}`,
      ),
    );
  }
  async createInbox(
    accountId: number,
    name: string,
    webhookUrl: string,
  ): Promise<ChatwootInbox> {
    return inbox.parse(
      await this.request("POST", this.account(accountId) + "/inboxes", {
        name,
        greeting_enabled: false,
        enable_auto_assignment: false,
        channel: { type: "api", webhook_url: webhookUrl },
      }),
    );
  }
  async configureInbox(
    accountId: number,
    inboxId: number,
    webhookUrl: string,
  ): Promise<ChatwootInbox> {
    return inbox.parse(
      await this.request(
        "PATCH",
        this.account(accountId) + `/inboxes/${integer.parse(inboxId)}`,
        { channel: { webhook_url: webhookUrl } },
      ),
    );
  }
  async assignAgents(
    accountId: number,
    inboxId: number,
    userIds: number[],
  ): Promise<void> {
    await this.request("POST", this.account(accountId) + "/inbox_members", {
      inbox_id: integer.parse(inboxId),
      user_ids: z.array(integer).max(100).parse(userIds),
    });
  }
  async agents(accountId: number) {
    return z
      .array(z.object({ id: integer, name: z.string(), email: z.email() }))
      .max(10000)
      .parse(await this.request("GET", this.account(accountId) + "/agents"));
  }
  async teams(accountId:number) {
    const teams=parseCatalog(z.array(z.object({id:integer,name:catalogName,account_id:integer,allow_auto_assign:z.boolean().optional()})).max(10000),
      await this.request('GET',this.account(accountId)+'/teams'));
    if(teams.some(team=>team.account_id!==accountId))throw new ChatwootError('CHATWOOT_BINDING_MISMATCH');
    return teams;
  }
  async teamAgents(accountId:number,teamId:number) {
    return parseCatalog(z.array(z.object({id:integer,name:catalogName})).max(10000),
      await this.request('GET',this.account(accountId)+`/teams/${integer.parse(teamId)}/team_members`));
  }
  async labels(accountId:number) {
    return parseCatalog(z.array(z.object({id:integer,title:catalogName})).max(10000),
      record(await this.request('GET',this.account(accountId)+'/labels')).payload);
  }
  async attributeDefinitions(accountId:number) {
    return parseCatalog(z.array(z.object({id:integer,attribute_key:catalogName,attribute_display_name:catalogName,
      attribute_display_type:z.string().max(100),attribute_model:z.string().max(100),attribute_values:z.array(catalogName).max(1000).nullable().optional()})).max(10000),
      await this.request('GET',this.account(accountId)+'/custom_attribute_definitions'));
  }
  async attendanceInbox(accountId:number,inboxId:number) {
    return parseCatalog(z.object({id:integer,name:catalogName,channel_type:z.string().max(100),
      greeting_enabled:z.boolean().optional(),enable_auto_assignment:z.boolean().optional(),working_hours_enabled:z.boolean().optional(),
      timezone:z.string().max(200).nullable().optional(),working_hours:z.array(workingHour).max(7).optional()}),
      await this.request('GET',this.account(accountId)+`/inboxes/${integer.parse(inboxId)}`));
  }
  async inboxAgents(accountId: number, inboxId: number) {
    const result = record(
      await this.request(
        "GET",
        this.account(accountId) + `/inbox_members/${integer.parse(inboxId)}`,
      ),
    );
    return z
      .array(z.object({ id: integer, name: z.string(), email: z.email() }))
      .max(10000)
      .parse(result.payload);
  }
  async createAccount(name: string, organizationId: string): Promise<number> {
    const result = record(
      await this.request("POST", "/platform/api/v1/accounts", {
        name,
        locale: "pt_BR",
        custom_attributes: { jrc_organization_id: organizationId },
      }),
    );
    return integer.parse(result.id);
  }
  async platformAccount(accountId: number) {
    return z
      .object({
        id: integer,
        custom_attributes: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(
        await this.request(
          "GET",
          `/platform/api/v1/accounts/${integer.parse(accountId)}`,
        ),
      );
  }
  async platformUser(userId: number) {
    return z
      .object({
        id: integer,
        email: z.email(),
        access_token: z.string().min(1),
      })
      .parse(
        await this.request(
          "GET",
          `/platform/api/v1/users/${integer.parse(userId)}`,
        ),
      );
  }
  async platformAccountUsers(accountId: number) {
    return z
      .array(
        z.object({ user_id: integer, role: z.union([z.string(), z.number()]) }),
      )
      .parse(
        await this.request(
          "GET",
          `/platform/api/v1/accounts/${integer.parse(accountId)}/account_users`,
        ),
      );
  }
  async createUser(input: {
    name: string;
    email: string;
    password: string;
    organizationId: string;
  }): Promise<{ id: number; token: string }> {
    const result = record(
      await this.request("POST", "/platform/api/v1/users", {
        name: input.name,
        email: input.email,
        password: input.password,
        custom_attributes: { jrc_organization_id: input.organizationId },
      }),
    );
    return {
      id: integer.parse(result.id),
      token: z.string().min(1).parse(result.access_token),
    };
  }
  async addAccountUser(
    accountId: number,
    userId: number,
    role: "administrator" | "agent",
  ): Promise<void> {
    await this.request(
      "POST",
      `/platform/api/v1/accounts/${integer.parse(accountId)}/account_users`,
      { user_id: integer.parse(userId), role },
    );
  }
  async findContact(
    accountId: number,
    phone: string,
  ): Promise<number | undefined> {
    const data = record(
      await this.request(
        "GET",
        this.account(accountId) +
          "/contacts/search?q=" +
          encodeURIComponent("+" + phone),
      ),
    );
    const matches = z
      .array(
        z.object({
          id: integer,
          phone_number: z.string().nullable().optional(),
        }),
      )
      .parse(data.payload);
    const exact = matches.filter(
      (contact) => contact.phone_number?.replace(/\D/gu, "") === phone,
    );
    if (exact.length > 1) throw new ChatwootError("CHATWOOT_CONTACT_AMBIGUOUS");
    return exact[0]?.id;
  }
  async createContact(
    accountId: number,
    input: { inboxId: number; phone: string; name: string; identifier: string },
  ): Promise<number> {
    const data = record(
      await this.request("POST", this.account(accountId) + "/contacts", {
        inbox_id: input.inboxId,
        name: input.name,
        phone_number: "+" + input.phone,
        identifier: input.identifier,
      }),
    );
    return integer.parse(record(record(data.payload).contact).id);
  }
  async linkContactInbox(
    accountId: number,
    contactId: number,
    inboxId: number,
    sourceId: string,
  ): Promise<string> {
    const data = record(
      await this.request(
        "POST",
        this.account(accountId) +
          `/contacts/${integer.parse(contactId)}/contact_inboxes`,
        { inbox_id: integer.parse(inboxId), source_id: sourceId },
      ),
    );
    return z.string().min(1).parse(data.source_id);
  }
  async createConversation(
    accountId: number,
    input: { inboxId: number; contactId: number; sourceId: string; status?: 'open' | 'pending' },
  ): Promise<number> {
    const data = record(
      await this.request("POST", this.account(accountId) + "/conversations", {
        inbox_id: input.inboxId,
        contact_id: input.contactId,
        source_id: input.sourceId,
        status: input.status ?? "open",
      }),
    );
    return integer.parse(data.id);
  }
  async contact(accountId: number, contactId: number) {
    const result = record(
      await this.request(
        "GET",
        this.account(accountId) + `/contacts/${integer.parse(contactId)}`,
      ),
    );
    return z
      .object({
        id: integer,
        phone_number: z.string().nullable(),
        contact_inboxes: z
          .array(
            z.object({
              source_id: z.string(),
              inbox: z.object({ id: integer }),
            }),
          )
          .default([]),
      })
      .parse(result.payload);
  }
  async attendanceConversation(accountId:number,conversationId:number) {
    const result=parseCatalog(z.object({id:integer,account_id:integer,inbox_id:integer,status:z.enum(['pending','open','resolved','snoozed']),
      updated_at:z.number().finite().nonnegative().optional(),
      meta:z.object({sender:z.object({id:integer}),assignee:z.object({id:integer,type:z.string().optional()}).nullable(),
        assignee_type:z.enum(['User','AgentBot']).nullable().optional(),team:z.object({id:integer}).nullable()})}),
    await this.request('GET',this.account(accountId)+`/conversations/${integer.parse(conversationId)}`));
    if(result.id!==conversationId||result.account_id!==accountId)throw new ChatwootError('CHATWOOT_BINDING_MISMATCH');
    return result;
  }
  async clearAttendanceAssignment(accountId:number,conversationId:number,kind:'AGENT'|'TEAM') {
    // Stock Chatwoot chooses assignee_id before team_id. Never combine these fields.
    await this.request('POST',this.account(accountId)+`/conversations/${integer.parse(conversationId)}/assignments`,
      kind==='AGENT'?{assignee_id:null}:{team_id:null});
  }
  async pendingAttendanceConversation(accountId:number,conversationId:number) {
    await this.request('POST',this.account(accountId)+`/conversations/${integer.parse(conversationId)}/toggle_status`,{status:'pending'});
  }
  async conversation(accountId: number, conversationId: number) {
    return z
      .object({
        id: integer,
        account_id: integer,
        inbox_id: integer,
        meta: z.object({
          sender: z.object({
            id: integer,
            phone_number: z.string().nullable(),
            name: z.string().optional(),
          }),
        }),
      })
      .parse(
        await this.request(
          "GET",
          this.account(accountId) +
            `/conversations/${integer.parse(conversationId)}`,
        ),
      );
  }
  async findBrokerMessage(
    accountId: number,
    conversationId: number,
    brokerMessageId: string,
    remoteId?: number,
  ): Promise<number | undefined> {
    const query = remoteId
      ? `?before=${integer.max(Number.MAX_SAFE_INTEGER - 1).parse(remoteId) + 1}`
      : "";
    const data = record(
      await this.request(
        "GET",
        this.account(accountId) +
          `/conversations/${integer.parse(conversationId)}/messages` +
          query,
      ),
    );
    const messages = z
      .array(
        z.object({
          id: integer,
          content_attributes: z.record(z.string(), z.unknown()).default({}),
        }),
      )
      .max(1000)
      .parse(data.payload);
    const matches = messages.filter(
      (m) =>
        m.content_attributes.jrc_broker_message_id === brokerMessageId &&
        (!remoteId || m.id === remoteId),
    );
    if (matches.length > 1)
      throw new ChatwootError("CHATWOOT_MESSAGE_AMBIGUOUS");
    return matches[0]?.id;
  }
  /** Chatwoot exposes a bounded message list, not a GET for an individual message. */
  async canonicalMessage(accountId:number,inboxId:number,conversationId:number,messageId:number) {
    const messages=await this.centralMessages(accountId,inboxId,conversationId,messageId);
    const matches=messages.filter(message=>message.id===messageId);
    if(matches.length!==1)throw new ChatwootError('CHATWOOT_MESSAGE_NOT_PROVEN',true);
    return matches[0]!;
  }
  async centralMessages(accountId:number,inboxId:number,conversationId:number,beforeId?:number) {
    integer.parse(inboxId);
    const query=beforeId===undefined?'':`?before=${integer.max(Number.MAX_SAFE_INTEGER-1).parse(beforeId)+1}`;
    const data=record(await this.request('GET',this.account(accountId)+`/conversations/${integer.parse(conversationId)}/messages${query}`));
    const schema=z.object({id:integer,account_id:integer.optional(),inbox_id:integer,conversation_id:integer,
      message_type:z.union([z.literal(0),z.literal(1),z.literal(2),z.literal(3),z.enum(['incoming','outgoing','activity','template'])]),
      private:z.boolean(),content:z.string().nullable(),content_type:z.string().optional(),attachments:z.array(z.unknown()).max(100).optional(),
      content_attributes:z.record(z.string(),z.unknown()).default({}),status:z.enum(['sent','delivered','read','failed']).optional(),
      sender:z.object({id:integer,type:z.string().optional()}).nullable().optional(),created_at:z.number().finite().nonnegative()});
    const messages=parseCatalog(z.array(schema).max(100),data.payload);
    if(messages.some(message=>message.account_id!==undefined&&message.account_id!==accountId||message.inbox_id!==inboxId||message.conversation_id!==conversationId))
      throw new ChatwootError('CHATWOOT_BINDING_MISMATCH');
    return messages.map(message=>({...message,message_type:typeof message.message_type==='number'?['incoming','outgoing','activity','template'][message.message_type]!:message.message_type}));
  }
  async sendMessage(
    accountId: number,
    conversationId: number,
    input: { text: string; incoming: boolean; brokerMessageId: string; dispatchProof?: string; messageOrigin?:'EXTERNAL_OBSERVED' },
  ): Promise<number> {
    const data = record(
      await this.request(
        "POST",
        this.account(accountId) +
          `/conversations/${integer.parse(conversationId)}/messages`,
        {
          content: input.text,
          message_type: input.incoming ? "incoming" : "outgoing",
          private: false,
          content_attributes: { jrc_broker_message_id: input.brokerMessageId,
            ...(input.messageOrigin==='EXTERNAL_OBSERVED'?{jrc_broker_message_origin:input.messageOrigin}:{}),
            ...(input.dispatchProof ? {jrc_broker_dispatch_proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(input.dispatchProof)} : {}) },
        },
      ),
    );
    return integer.parse(data.id);
  }
  async sendMedia(
    accountId: number,
    conversationId: number,
    file: BinaryMedia,
    input: { incoming: boolean; brokerMessageId: string; messageOrigin?:'EXTERNAL_OBSERVED' },
  ): Promise<number> {
    validateMedia(file);
    const form = new FormData();
    form.set("content", file.caption ?? "");
    form.set("message_type", input.incoming ? "incoming" : "outgoing");
    form.set("private", "false");
    form.set(
      "content_attributes",
      JSON.stringify({ jrc_broker_message_id: input.brokerMessageId,
        ...(input.messageOrigin==='EXTERNAL_OBSERVED'?{jrc_broker_message_origin:input.messageOrigin}:{}) }),
    );
    form.append(
      "attachments[]",
      new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }),
      safeMediaName(file.fileName),
    );
    return integer.parse(
      record(
        await this.request(
          "POST",
          this.account(accountId) +
            `/conversations/${integer.parse(conversationId)}/messages`,
          form,
        ),
      ).id,
    );
  }
  async downloadAttachment(
    accountId: number,
    inboxId: number,
    conversationId: number,
    messageId: number,
    attachmentId: number,
  ): Promise<BinaryMedia> {
    const conversation = await this.conversation(accountId, conversationId);
    if (
      conversation.account_id !== accountId ||
      conversation.inbox_id !== inboxId
    )
      throw new MediaError("CHATWOOT_BINDING_MISMATCH");
    const data = record(
      await this.request(
        "GET",
        this.account(accountId) +
          `/conversations/${integer.parse(conversationId)}/messages?before=${integer.max(Number.MAX_SAFE_INTEGER - 1).parse(messageId) + 1}`,
      ),
    );
    const messages = z
      .array(
        z.object({
          id: integer,
          attachments: z
            .array(
              z.object({
                id: integer,
                account_id: integer.optional(),
                message_id: integer.optional(),
                data_url: z.url(),
                file_type: z.string(),
              }),
            )
            .default([]),
        }),
      )
      .max(1000)
      .parse(data.payload);
    const asset = messages
      .find((m) => m.id === messageId)
      ?.attachments.find((a) => a.id === attachmentId);
    if (
      !asset ||
      (asset.account_id !== undefined && asset.account_id !== accountId) ||
      (asset.message_id !== undefined && asset.message_id !== messageId)
    )
      throw new MediaError("MEDIA_NOT_FOUND");
    const allowed = new Set([
      this.origin,
      ...(this.options.mediaOrigins ?? []),
    ]);
    let url = new URL(asset.data_url);
    for (let attempt = 0; attempt < 4; attempt++) {
      // Credentials belong only on API calls. Attachment URLs are signed by Active Storage or the configured object store.
      if (
        !allowed.has(url.origin) ||
        url.username ||
        url.password ||
        url.hash ||
        (!this.options.allowLocal && url.protocol !== "https:")
      )
        throw new MediaError("MEDIA_ORIGIN_NOT_ALLOWED");
      if (
        url.origin === this.origin &&
        !url.pathname.startsWith("/rails/active_storage/")
      )
        throw new MediaError("MEDIA_PATH_NOT_ALLOWED");
      let response: Response;
      try {
        response = await this.fetch(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 15000),
        });
      } catch {
        throw new MediaError("MEDIA_DOWNLOAD_FAILED", true);
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new MediaError("MEDIA_DOWNLOAD_FAILED");
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new MediaError(
          "MEDIA_DOWNLOAD_FAILED",
          response.status === 429 || response.status >= 500,
        );
      }
      const mimeType = (response.headers.get("content-type") ?? "")
        .split(";")[0]!
        .trim()
        .toLowerCase();
      const bytes = await readMediaBytes(response);
      const kind = mediaKind(mimeType);
      const fileName = safeMediaName(
        decodeURIComponent(url.pathname.split("/").pop() ?? "arquivo"),
      );
      const file = { bytes, mimeType, kind, fileName };
      validateMedia(file);
      return file;
    }
    throw new MediaError("MEDIA_REDIRECT_LIMIT");
  }
  async updateMessageStatus(
    accountId: number,
    conversationId: number,
    messageId: number,
    state: "sent" | "delivered" | "read" | "failed",
    error?: string,
  ): Promise<void> {
    await this.request(
      "PATCH",
      this.account(accountId) +
        `/conversations/${integer.parse(conversationId)}/messages/${integer.parse(messageId)}`,
      { status: state, ...(error ? { external_error: error } : {}) },
    );
  }
}
