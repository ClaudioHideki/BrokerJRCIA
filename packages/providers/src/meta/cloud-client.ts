import {
  MAX_MEDIA_BYTES,
  MediaError,
  mediaKind,
  readMediaBytes,
  safeMediaName,
  validateMedia,
  type BinaryMedia,
  type MediaKind,
} from "../media.js";
/**
 * HTTP contract source reviewed 2026-09-14:
 * https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api
 *
 * Meta's collection leaves `Version` as an environment variable. This client
 * therefore has no default Graph version: deployments must configure a version
 * they have independently verified as supported for their Meta assets.
 */

export type MetaCloudErrorCode =
  | "INVALID_META_CONFIGURATION"
  | "INVALID_META_INPUT"
  | "META_INVALID_RESPONSE"
  | "META_REQUEST_FAILED"
  | "META_REQUEST_REJECTED"
  | "META_RESPONSE_TOO_LARGE"
  | "META_SEND_UNKNOWN"
  | "META_TIMEOUT";

export interface MetaCloudError extends Error {
  code: MetaCloudErrorCode;
}

export type MetaCloudFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface MetaCloudClientOptions {
  accessToken: string;
  graphVersion: string;
  phoneNumberId: string;
  wabaId: string;
  fetch?: MetaCloudFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxTemplatePages?: number;
}

export interface MetaTemplateSendInput {
  name: string;
  language: string;
  components?: readonly Readonly<Record<string, unknown>>[];
}

export interface MetaAcceptedMessage {
  /** Meta accepted the request and returned this ID; delivery is asynchronous. */
  status: "ACCEPTED";
  upstreamMessageId: string;
}

export interface MetaMessageTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components: readonly unknown[];
}

const GRAPH_ORIGIN = "https://graph.facebook.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_TEMPLATE_PAGES = 20;
const TEMPLATE_PAGE_SIZE = 100;
const MAX_REQUEST_BYTES = 65_536;
const MAX_ACCESS_TOKEN_BYTES = 4_096;
const MAX_TEXT_LENGTH = 4_096;
const MAX_CURSOR_LENGTH = 2_048;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_COLLECTION_ITEMS = 100;
const MAX_JSON_STRING_LENGTH = 8_192;

function metaCloudError(code: MetaCloudErrorCode): MetaCloudError {
  return Object.assign(new Error(code), {
    name: "MetaCloudError",
    code,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasBoundedUtf8(value: string, maximumBytes: number): boolean {
  return Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function validSecret(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    hasBoundedUtf8(value, MAX_ACCESS_TOKEN_BYTES) &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validGraphVersion(value: unknown): value is string {
  return typeof value === "string" && /^v[1-9]\d{0,2}\.0$/u.test(value);
}

function validMetaId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{4,63}$/u.test(value);
}

function validPositiveInteger(
  value: unknown,
  maximum: number,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= maximum
  );
}

function validRecipient(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{4,19}$/u.test(value);
}

function validTemplateName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_]{1,512}$/u.test(value);
}

function validLanguage(value: unknown): value is string {
  return typeof value === "string" && /^[a-z]{2,3}(?:_[A-Z]{2})?$/u.test(value);
}

function validBoundedString(
  value: unknown,
  maximumLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength
  );
}

function isBoundedJson(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) {
    return false;
  }
  if (value === null || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value === "string") {
    return value.length <= MAX_JSON_STRING_LENGTH;
  }
  if (Array.isArray(value)) {
    return (
      value.length <= MAX_JSON_COLLECTION_ITEMS &&
      value.every((entry) => isBoundedJson(entry, depth + 1))
    );
  }
  if (!isRecord(value)) {
    return false;
  }
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_JSON_COLLECTION_ITEMS &&
    entries.every(
      ([key, entry]) => key.length <= 128 && isBoundedJson(entry, depth + 1),
    )
  );
}

function serializeRequestBody(value: unknown): string {
  if (!isBoundedJson(value)) {
    throw metaCloudError("INVALID_META_INPUT");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw metaCloudError("INVALID_META_INPUT");
  }
  if (!hasBoundedUtf8(serialized, MAX_REQUEST_BYTES)) {
    throw metaCloudError("INVALID_META_INPUT");
  }
  return serialized;
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maximumBytes) {
      throw metaCloudError("META_RESPONSE_TOO_LARGE");
    }
  }
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      receivedBytes += result.value.byteLength;
      if (receivedBytes > maximumBytes) {
        await reader.cancel();
        throw metaCloudError("META_RESPONSE_TOO_LARGE");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw metaCloudError("META_INVALID_RESPONSE");
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw metaCloudError("META_INVALID_RESPONSE");
  }
}

function parseAcceptedMessage(value: unknown): MetaAcceptedMessage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.messages) ||
    value.messages.length < 1
  ) {
    throw metaCloudError("META_INVALID_RESPONSE");
  }
  const firstMessage = value.messages[0];
  if (!isRecord(firstMessage) || !validBoundedString(firstMessage.id, 512)) {
    throw metaCloudError("META_INVALID_RESPONSE");
  }
  return {
    status: "ACCEPTED",
    upstreamMessageId: firstMessage.id,
  };
}

interface ParsedTemplatePage {
  templates: MetaMessageTemplate[];
  after: string | null;
}

function parseTemplatePage(value: unknown): ParsedTemplatePage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.data) ||
    value.data.length > TEMPLATE_PAGE_SIZE
  ) {
    throw metaCloudError("META_INVALID_RESPONSE");
  }

  const templates = value.data.map((entry): MetaMessageTemplate => {
    if (
      !isRecord(entry) ||
      !validMetaId(entry.id) ||
      !validTemplateName(entry.name) ||
      !validLanguage(entry.language) ||
      !validBoundedString(entry.status, 64) ||
      !validBoundedString(entry.category, 64) ||
      !Array.isArray(entry.components) ||
      !isBoundedJson(entry.components)
    ) {
      throw metaCloudError("META_INVALID_RESPONSE");
    }
    return {
      id: entry.id,
      name: entry.name,
      language: entry.language,
      status: entry.status,
      category: entry.category,
      components: entry.components,
    };
  });

  if (value.paging === undefined) {
    return { templates, after: null };
  }
  if (!isRecord(value.paging)) {
    throw metaCloudError("META_INVALID_RESPONSE");
  }
  if (value.paging.next === undefined) {
    return { templates, after: null };
  }
  if (
    !validBoundedString(value.paging.next, 4_096) ||
    !isRecord(value.paging.cursors)
  ) {
    throw metaCloudError("META_INVALID_RESPONSE");
  }
  const after = value.paging.cursors.after;
  if (!validBoundedString(after, MAX_CURSOR_LENGTH)) {
    throw metaCloudError("META_INVALID_RESPONSE");
  }
  return { templates, after };
}

function isMetaCloudError(error: unknown): error is MetaCloudError {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.message === error.code
  );
}

export class MetaCloudClient {
  readonly #accessToken: string;
  readonly #graphVersion: string;
  readonly #phoneNumberId: string;
  readonly #wabaId: string;
  readonly #fetch: MetaCloudFetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #maxTemplatePages: number;

  constructor(options: MetaCloudClientOptions) {
    if (
      !isRecord(options) ||
      !validSecret(options.accessToken) ||
      !validGraphVersion(options.graphVersion) ||
      !validMetaId(options.phoneNumberId) ||
      !validMetaId(options.wabaId) ||
      (options.fetch !== undefined && typeof options.fetch !== "function") ||
      !validPositiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60_000) ||
      !validPositiveInteger(
        options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        4_194_304,
      ) ||
      !validPositiveInteger(
        options.maxTemplatePages ?? DEFAULT_MAX_TEMPLATE_PAGES,
        1_000,
      )
    ) {
      throw metaCloudError("INVALID_META_CONFIGURATION");
    }

    this.#accessToken = options.accessToken;
    this.#graphVersion = options.graphVersion;
    this.#phoneNumberId = options.phoneNumberId;
    this.#wabaId = options.wabaId;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#maxTemplatePages =
      options.maxTemplatePages ?? DEFAULT_MAX_TEMPLATE_PAGES;
  }

  async sendText(to: string, text: string): Promise<MetaAcceptedMessage> {
    if (!validRecipient(to) || !validBoundedString(text, MAX_TEXT_LENGTH)) {
      throw metaCloudError("INVALID_META_INPUT");
    }
    return this.#send({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body: text },
    });
  }

  async sendTemplate(
    to: string,
    template: MetaTemplateSendInput,
  ): Promise<MetaAcceptedMessage> {
    if (
      !validRecipient(to) ||
      !isRecord(template) ||
      !validTemplateName(template.name) ||
      !validLanguage(template.language) ||
      (template.components !== undefined &&
        !Array.isArray(template.components)) ||
      (template.components !== undefined && !isBoundedJson(template.components))
    ) {
      throw metaCloudError("INVALID_META_INPUT");
    }

    return this.#send({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language },
        ...(template.components === undefined
          ? {}
          : { components: template.components }),
      },
    });
  }

  async listTemplates(): Promise<MetaMessageTemplate[]> {
    const templates: MetaMessageTemplate[] = [];
    const observedCursors = new Set<string>();
    let after: string | null = null;

    for (
      let pageNumber = 1;
      pageNumber <= this.#maxTemplatePages;
      pageNumber += 1
    ) {
      const url = this.#graphUrl(`${this.#wabaId}/message_templates`);
      url.searchParams.set("limit", String(TEMPLATE_PAGE_SIZE));
      if (after !== null) {
        url.searchParams.set("after", after);
      }

      const page = parseTemplatePage(await this.#getJson(url));
      templates.push(...page.templates);
      if (page.after === null) {
        return templates;
      }
      if (
        observedCursors.has(page.after) ||
        pageNumber === this.#maxTemplatePages
      ) {
        throw metaCloudError("META_INVALID_RESPONSE");
      }
      observedCursors.add(page.after);
      after = page.after;
    }

    throw metaCloudError("META_INVALID_RESPONSE");
  }
  /** Media ownership is checked by Graph against this channel's phone, before downloading. */
  async downloadMedia(id: string): Promise<BinaryMedia> {
    if (!validMetaId(id)) throw new MediaError("MEDIA_REFERENCE_INVALID");
    const url = this.#graphUrl(id);
    url.searchParams.set("phone_number_id", this.#phoneNumberId);
    const metadata = await this.#getJson(url);
    if (
      !isRecord(metadata) ||
      typeof metadata.url !== "string" ||
      typeof metadata.mime_type !== "string" ||
      String(metadata.id) !== id
    )
      throw new MediaError("MEDIA_DOWNLOAD_FAILED", true);
    if (Number(metadata.file_size) > MAX_MEDIA_BYTES)
      throw new MediaError("MEDIA_SIZE_LIMIT");
    const download = new URL(metadata.url);
    if (
      download.protocol !== "https:" ||
      download.username ||
      download.password ||
      download.port ||
      ![
        "graph.facebook.com",
        "lookaside.fbsbx.com",
        "mmg.whatsapp.net",
      ].includes(download.hostname)
    )
      throw new MediaError("MEDIA_ORIGIN_REJECTED");
    let response: Response;
    try {
      response = await this.#fetch(download, {
        method: "GET",
        redirect: "error",
        headers: this.#headers(false),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new MediaError("MEDIA_DOWNLOAD_FAILED", true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new MediaError("MEDIA_DOWNLOAD_FAILED", true);
    }
    const mimeType = metadata.mime_type.split(";")[0]!.toLowerCase();
    const media: BinaryMedia = {
      bytes: await readMediaBytes(response),
      mimeType,
      kind: mediaKind(mimeType),
      fileName: "arquivo-" + id,
    };
    validateMedia(media);
    return media;
  }
  async uploadMedia(media: BinaryMedia): Promise<string> {
    validateMedia(media);
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", media.mimeType);
    form.set(
      "file",
      new Blob([new Uint8Array(media.bytes)], { type: media.mimeType }),
      safeMediaName(media.fileName),
    );
    try {
      const response = await this.#fetch(
        this.#graphUrl(`${this.#phoneNumberId}/media`),
        {
          method: "POST",
          headers: this.#headers(false),
          body: form,
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new MediaError(
          "MEDIA_UPLOAD_FAILED",
          response.status === 429 || response.status >= 500,
        );
      }
      const result = parseJson(
        await readBoundedResponse(response, this.#maxResponseBytes),
      );
      if (!isRecord(result) || !validMetaId(result.id))
        throw new MediaError("MEDIA_UPLOAD_FAILED", true);
      return result.id;
    } catch (error) {
      if (error instanceof MediaError) throw error;
      throw new MediaError("MEDIA_UPLOAD_FAILED", true);
    }
  }
  async sendMedia(
    to: string,
    input: { id: string; kind: MediaKind; caption?: string; fileName?: string },
  ): Promise<MetaAcceptedMessage> {
    if (
      !validRecipient(to) ||
      !validMetaId(input.id) ||
      !["image", "audio", "video", "document", "sticker"].includes(
        input.kind,
      ) ||
      (input.caption && input.caption.length > 1024)
    )
      throw metaCloudError("INVALID_META_INPUT");
    return this.#send({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: input.kind,
      [input.kind]: {
        id: input.id,
        ...(["image", "video", "document"].includes(input.kind) && input.caption
          ? { caption: input.caption }
          : {}),
        ...(input.kind === "document" && input.fileName
          ? { filename: safeMediaName(input.fileName) }
          : {}),
      },
    });
  }

  async #send(payload: unknown): Promise<MetaAcceptedMessage> {
    const body = serializeRequestBody(payload);
    const signal = AbortSignal.timeout(this.#timeoutMs);
    try {
      const response = await this.#fetch(
        this.#graphUrl(`${this.#phoneNumberId}/messages`),
        {
          method: "POST",
          headers: this.#headers(true),
          body,
          redirect: "error",
          signal,
        },
      );
      if (response.status >= 400 && response.status < 500) {
        throw metaCloudError("META_REQUEST_REJECTED");
      }
      if (!response.ok) {
        throw metaCloudError("META_SEND_UNKNOWN");
      }
      const responseText = await readBoundedResponse(
        response,
        this.#maxResponseBytes,
      );
      return parseAcceptedMessage(parseJson(responseText));
    } catch (error) {
      if (isMetaCloudError(error) && error.code === "META_REQUEST_REJECTED") {
        throw error;
      }
      throw metaCloudError("META_SEND_UNKNOWN");
    }
  }

  async #getJson(url: URL): Promise<unknown> {
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: this.#headers(false),
        redirect: "error",
        signal,
      });
    } catch {
      throw metaCloudError(
        signal.aborted ? "META_TIMEOUT" : "META_REQUEST_FAILED",
      );
    }
    if (!response.ok) {
      throw metaCloudError("META_REQUEST_FAILED");
    }
    try {
      return parseJson(
        await readBoundedResponse(response, this.#maxResponseBytes),
      );
    } catch (error) {
      if (isMetaCloudError(error)) {
        throw error;
      }
      throw metaCloudError(
        signal.aborted ? "META_TIMEOUT" : "META_INVALID_RESPONSE",
      );
    }
  }

  #graphUrl(path: string): URL {
    return new URL(`/${this.#graphVersion}/${path}`, GRAPH_ORIGIN);
  }

  #headers(hasBody: boolean): Headers {
    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${this.#accessToken}`,
    });
    if (hasBody) {
      headers.set("content-type", "application/json");
    }
    return headers;
  }
}
