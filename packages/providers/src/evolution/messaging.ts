import type { EvolutionFetch } from "./client.js";
import type { ProviderContext } from '../contracts/types.js';
import {
  MAX_MEDIA_BYTES,
  MediaError,
  mediaKind,
  safeMediaName,
  validateMedia,
  type BinaryMedia,
} from "../media.js";
import type {
  MetaAcceptedMessage,
  MetaMessageTemplate,
  MetaTemplateSendInput,
} from "../meta/cloud-client.js";

type Options = {
  baseUrl: string;
  apiKey: string;
  instanceKey: string;
  fetch?: EvolutionFetch;
  timeoutMs?: number;
};
const failure = (code: string) => Object.assign(new Error(code), { code });
const webhookEvents = ['MESSAGES_UPSERT','MESSAGES_UPDATE','CONNECTION_UPDATE','GROUPS_UPSERT','GROUPS_UPDATE','GROUP_PARTICIPANTS_UPDATE'];
function webhookDestination(url:string,secret:string) {
  const target=new URL(url);
  if(!['http:','https:'].includes(target.protocol)||target.username||target.password||target.search||target.hash||!secret)
    throw failure('INVALID_QR_INPUT');
}
/** Private engine contract, verified against the preserved v2 upstream source. No public engine credentials. */
export class EvolutionMessagingClient {
  async readWebhookConfiguration(url: string, secret: string, context?:ProviderContext): Promise<'MATCHING'|'MISMATCHED'|'MISSING'> {
    webhookDestination(url,secret);
    try {
      const response=await this.request(new URL(`webhook/find/${encodeURIComponent(this.options.instanceKey)}`,this.origin),{
        method:'GET',headers:{apikey:this.options.apiKey},redirect:'error',signal:this.signal(context),
      });
      if(!response.ok){await response.body?.cancel();throw new Error();}
      const reader=response.body?.getReader();if(!reader)throw new Error();
      let size=0;const chunks:Uint8Array[]=[];
      for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
        if(size>65536){await reader.cancel();throw new Error();}chunks.push(part.value);}
      const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(value===null)return 'MISSING';
      if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();
      const record=value as Record<string,unknown>,headers=record.headers;
      const events=record.events;
      // Request DTO uses byEvents/base64. GET returns the stored Prisma names.
      return record.enabled===true&&record.url===url&&record.webhookByEvents===false&&record.webhookBase64===false
        &&headers!==null&&typeof headers==='object'&&!Array.isArray(headers)
        &&(headers as Record<string,unknown>).Authorization===`Bearer ${secret}`
        &&Array.isArray(events)&&events.length===webhookEvents.length&&new Set(events).size===events.length
        &&webhookEvents.every(event=>events.includes(event))?'MATCHING':'MISMATCHED';
    }catch{throw failure('QR_CONFIGURATION_UNAVAILABLE');}
  }
  private readonly origin: URL;
  private readonly request: EvolutionFetch;
  constructor(private readonly options: Options) {
    this.origin = new URL(options.baseUrl);
    if (
      !["https:", "http:"].includes(this.origin.protocol) ||
      this.origin.username ||
      this.origin.password ||
      this.origin.search ||
      this.origin.hash ||
      this.origin.pathname !== "/" ||
      !options.apiKey ||
      !options.instanceKey
    )
      throw failure("INVALID_QR_CONFIGURATION");
    this.request = options.fetch ?? globalThis.fetch;
  }
  private signal(context?:ProviderContext) {
    const remaining=context?context.deadline.getTime()-Date.now():this.options.timeoutMs??15000;
    if(remaining<=0)throw failure('QR_CONFIGURATION_UNAVAILABLE');
    const timeout=AbortSignal.timeout(Math.min(remaining,this.options.timeoutMs??15000));
    return context?AbortSignal.any([timeout,context.signal]):timeout;
  }
  private async post(
    path: string,
    body: unknown,
    sending: boolean,
    maximumBytes = 1_048_576,
    context?:ProviderContext,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.request(
        new URL(
          `${path}/${encodeURIComponent(this.options.instanceKey)}`,
          this.origin,
        ),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: this.options.apiKey,
          },
          body: JSON.stringify(body),
          signal: this.signal(context),
          redirect: "error",
        },
      );
    } catch {
      throw failure(
        sending ? "QR_SEND_UNKNOWN" : "QR_CONFIGURATION_UNAVAILABLE",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([400, 401, 403, 404, 422].includes(response.status))
        throw failure("QR_REQUEST_REJECTED");
      if (response.status === 429) throw failure("QR_RATE_LIMITED");
      throw failure(
        sending ? "QR_SEND_UNKNOWN" : "QR_CONFIGURATION_UNAVAILABLE",
      );
    }
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maximumBytes) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(part.value);
      }
      const result: unknown = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      );
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw new Error();
      return result as Record<string, unknown>;
    } catch {
      throw failure(
        sending ? "QR_SEND_UNKNOWN" : "QR_CONFIGURATION_UNAVAILABLE",
      );
    }
  }
  async sendText(to: string, text: string): Promise<MetaAcceptedMessage> {
    if (!/^[1-9]\d{7,14}$/u.test(to) || !text || text.length > 4096)
      throw failure("INVALID_QR_INPUT");
    const body = await this.post(
      "message/sendText",
      { number: to, text, linkPreview: false },
      true,
    );
    const key = body.key as { id?: unknown } | undefined;
    if (typeof key?.id !== "string" || !key.id || key.id.length > 256)
      throw failure("QR_SEND_UNKNOWN");
    return { status: "ACCEPTED", upstreamMessageId: key.id };
  }
  async listTemplates(): Promise<MetaMessageTemplate[]> {
    return [];
  }
  async downloadMedia(messageId: string): Promise<BinaryMedia> {
    if (!messageId || messageId.length > 256)
      throw new MediaError("MEDIA_REFERENCE_INVALID");
    const result = await this.post(
      "chat/getBase64FromMediaMessage",
      { message: { key: { id: messageId } }, convertToMp4: false },
      false,
      Math.ceil((MAX_MEDIA_BYTES * 4) / 3) + 65536,
    );
    if (
      typeof result.base64 !== "string" ||
      typeof result.mimetype !== "string" ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(result.base64)
    )
      throw new MediaError("MEDIA_DOWNLOAD_FAILED", true);
    const media: BinaryMedia = {
      bytes: new Uint8Array(Buffer.from(result.base64, "base64")),
      mimeType: result.mimetype.split(";")[0]!.toLowerCase(),
      fileName: safeMediaName(
        typeof result.fileName === "string" ? result.fileName : "arquivo",
      ),
      kind: mediaKind(result.mimetype),
    };
    validateMedia(media);
    return media;
  }
  async sendMedia(
    to: string,
    media: BinaryMedia,
  ): Promise<MetaAcceptedMessage> {
    if (!/^[1-9]\d{7,14}$/.test(to)) throw failure("INVALID_QR_INPUT");
    validateMedia(media);
    const encoded = Buffer.from(media.bytes).toString("base64");
    const result = await this.post(
      media.kind === "sticker" ? "message/sendSticker" : "message/sendMedia",
      media.kind === "sticker"
        ? { number: to, sticker: encoded }
        : {
            number: to,
            mediatype: media.kind,
            mimetype: media.mimeType,
            media: encoded,
            fileName: safeMediaName(media.fileName),
            ...(media.caption ? { caption: media.caption } : {}),
          },
      true,
    );
    const key = result.key as { id?: unknown } | undefined;
    if (typeof key?.id !== "string" || !key.id || key.id.length > 256)
      throw failure("QR_SEND_UNKNOWN");
    return { status: "ACCEPTED", upstreamMessageId: key.id };
  }
  async sendTemplate(
    _to: string,
    _template: MetaTemplateSendInput,
  ): Promise<MetaAcceptedMessage> {
    throw failure("INVALID_QR_INPUT");
  }
  async configureWebhook(url: string, secret: string, context?:ProviderContext): Promise<void> {
    const destination = new URL(url);
    if (
      !["https:", "http:"].includes(destination.protocol) ||
      destination.username ||
      destination.password ||
      destination.search ||
      destination.hash ||
      !secret
    )
      throw failure("INVALID_QR_INPUT");
    await this.post(
      "webhook/set",
      {
        webhook: {
          enabled: true,
          url,
          byEvents: false,
          base64: false,
          headers: { Authorization: `Bearer ${secret}` },
          events: webhookEvents,
        },
      },
      false,
      65536,
      context,
    );
  }
}
