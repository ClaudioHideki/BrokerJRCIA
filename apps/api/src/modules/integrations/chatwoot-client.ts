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

const integer = z.number().int().positive();
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
      if (!reader) throw new Error();
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
  async listInboxes(accountId: number): Promise<ChatwootInbox[]> {
    const data = record(
      await this.request("GET", this.account(accountId) + "/inboxes"),
    );
    return z.array(inbox).max(10000).parse(data.payload);
  }
  async listDashboardApps(accountId: number): Promise<DashboardApp[]> {
    return z.array(dashboardApp).max(1000).parse(await this.request('GET', this.account(accountId) + '/dashboard_apps'));
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
    input: { inboxId: number; contactId: number; sourceId: string },
  ): Promise<number> {
    const data = record(
      await this.request("POST", this.account(accountId) + "/conversations", {
        inbox_id: input.inboxId,
        contact_id: input.contactId,
        source_id: input.sourceId,
        status: "open",
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
  async sendMessage(
    accountId: number,
    conversationId: number,
    input: { text: string; incoming: boolean; brokerMessageId: string },
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
          content_attributes: { jrc_broker_message_id: input.brokerMessageId },
        },
      ),
    );
    return integer.parse(data.id);
  }
  async sendMedia(
    accountId: number,
    conversationId: number,
    file: BinaryMedia,
    input: { incoming: boolean; brokerMessageId: string },
  ): Promise<number> {
    validateMedia(file);
    const form = new FormData();
    form.set("content", file.caption ?? "");
    form.set("message_type", input.incoming ? "incoming" : "outgoing");
    form.set("private", "false");
    form.set(
      "content_attributes",
      JSON.stringify({ jrc_broker_message_id: input.brokerMessageId }),
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
