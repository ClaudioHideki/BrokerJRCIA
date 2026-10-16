import { z } from "zod";
import type { MessageContent } from "./types.js";
import type { MediaRegistration } from "./media-store.js";
import { safeMediaName } from "@jrc/providers";
import { normalizeQrGroupEvents, type QrGroupEvent } from './qr-group-events.js';

export type QrContactEvent = ({
      kind: "message" | "outbound";
      upstreamMessageId: string;
      externalId: string;
      displayName: string | null;
      content: MessageContent;
      occurredAt: Date;
    } | {
      kind: "media" | "outbound-media";
      upstreamMessageId: string;
      externalId: string;
      displayName: string | null;
      media: MediaRegistration;
      caption: string;
      occurredAt: Date;
    }) & {lid?:string;recoveredIdentity?:boolean};
type WithoutPhone<T> = T extends unknown ? Omit<T,'externalId'> : never;
export type QrUnresolvedContactEvent=WithoutPhone<QrContactEvent>;
export type QrEvent =
  | QrContactEvent
  | {kind:'identity-pending';lid:string;event:QrUnresolvedContactEvent}
  | QrGroupEvent
  | {kind:'group-text';groupJid:string;upstreamMessageId:string;fromMe:boolean;participantJid:string|null;
      participantJidAlt:string|null;content:{type:'TEXT';text:string};occurredAt:Date}
  | {kind:'group-status';groupJid:string;upstreamMessageId:string;state:'SENT'|'DELIVERED'|'READ'|'FAILED'}
  | { kind: "connection"; state: "CONNECTED" | "DISCONNECTED"; identity?: string }
  | {
      kind: "status";
      upstreamMessageId: string;
      state: "SENT" | "DELIVERED" | "READ" | "FAILED";
    };
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const id = z.string().min(1).max(256);
const text = z.string().min(1).max(4096);
const groupJid=z.string().max(128).regex(/^\d+(?:-\d+)?@g\.us$/u);
const participantJid=z.string().max(128).regex(/^(?:[1-9]\d{6,14}(?::\d+)?@s\.whatsapp\.net|\d+(?::\d+)?@lid)$/u);
export function qrPhone(jid: unknown): string | undefined {
  if (typeof jid !== "string") return;
  return /^([1-9]\d{7,14})(?::\d+)?@s\.whatsapp\.net$/u.exec(jid)?.[1];
}
function lidAddress(jid:unknown):string|undefined{
  return typeof jid==='string' && /^\d{1,30}(?::\d{1,10})?@lid$/u.test(jid)?jid.replace(/:\d+(?=@)/u,''):undefined;
}
/** Inputs are authenticated by the route; tenant and instance are resolved from stored bindings. */
export function normalizeQrEvent(
  payload: unknown,
  expectedInstance: string,
): QrEvent[] {
  const envelope = object(payload);
  if (envelope.instance !== expectedInstance)
    throw new Error("QR_INSTANCE_MISMATCH");
  const event = String(envelope.event).toLowerCase().replace(/_/gu, ".");
  if (['groups.upsert', 'groups.update', 'group.participants.update', 'group-participants.update'].includes(event))
    return normalizeQrGroupEvents(payload, expectedInstance);
  if (event === "connection.update") {
    const data = object(envelope.data), state = data.state, identity = qrPhone(data.wuid);
    return state === "open"
      ? [{ kind: "connection", state: "CONNECTED", ...(identity ? { identity } : {}) }]
      : state === "close"
        ? [{ kind: "connection", state: "DISCONNECTED" }]
        : [];
  }
  if (!["messages.upsert", "messages.update"].includes(event)) return [];
  const items = Array.isArray(envelope.data) ? envelope.data : [envelope.data];
  if (items.length > 100) throw new Error("QR_EVENT_INVALID");
  try {
    return items.flatMap((item): QrEvent[] => {
      const data = object(item);
      const key = object(data.key);
      if (event === "messages.update") {
        const status = data.status ?? object(data.update).status;
        const states: Record<string, "SENT" | "DELIVERED" | "READ" | "FAILED"> =
          {
            SERVER_ACK: "SENT",
            DELIVERY_ACK: "DELIVERED",
            READ: "READ",
            PLAYED: "READ",
            ERROR: "FAILED",
            "0": "FAILED",
            "2": "SENT",
            "3": "DELIVERED",
            "4": "READ",
            "5": "READ",
          };
        const state = states[String(status)];
        const destination=data.remoteJid??key.remoteJid;
        if(state && typeof destination==='string' && destination.endsWith('@g.us'))
          return [{kind:'group-status',groupJid:groupJid.parse(destination),upstreamMessageId:id.parse(data.keyId??key.id),state}];
        return state
          ? [
              {
                kind: "status",
                upstreamMessageId: id.parse(data.keyId ?? key.id),
                state,
              },
            ]
          : [];
      }
      if(typeof key.remoteJid==='string' && key.remoteJid.endsWith('@g.us')) {
        const group=groupJid.parse(key.remoteJid);
        if(typeof key.fromMe!=='boolean')return [];
        const author=key.participant===undefined || key.participant===null ? null : participantJid.parse(key.participant);
        const alt=key.participantAlt===undefined || key.participantAlt===null ? null : participantJid.parse(key.participantAlt);
        if(!key.fromMe && !author)throw new Error('QR_EVENT_INVALID');
        const seconds=z.coerce.number().int().positive().max(253402300799).parse(data.messageTimestamp),occurredAt=new Date(seconds*1000);
        if(occurredAt.getTime()>Date.now()+300000)throw new Error('QR_EVENT_INVALID');
        let message=object(data.message);
        for(let i=0;i<3;i++) {
          const wrapped=object(message.ephemeralMessage??message.viewOnceMessage??message.viewOnceMessageV2);
          if(!wrapped.message)break;message=object(wrapped.message);
        }
        if(message.protocolMessage||message.reactionMessage||message.senderKeyDistributionMessage)return [];
        const body=message.conversation??object(message.extendedTextMessage).text;
        if(body===undefined)return [];
        return [{kind:'group-text',groupJid:group,upstreamMessageId:id.parse(key.id),fromMe:key.fromMe,
          participantJid:author,participantJidAlt:alt,content:{type:'TEXT',text:text.parse(body)},occurredAt}];
      }
      if (
        typeof key.remoteJid !== "string" ||
        /@(g\.us|broadcast|newsletter)$/u.test(key.remoteJid)
      )
        return [];
      const externalId = qrPhone(key.remoteJid) ?? qrPhone(key.remoteJidAlt);
      const lid=lidAddress(key.remoteJid)??lidAddress(key.remoteJidAlt);
      if (!externalId&&!lid) throw new Error("QR_EVENT_INVALID");
      const contactEvent=(value:QrUnresolvedContactEvent):QrEvent=>externalId
        ? {...value,externalId,...(lid?{lid}:{})} as QrContactEvent
        : {kind:'identity-pending',lid:lid!,event:value};
      const seconds = z.coerce
        .number()
        .int()
        .positive()
        .max(253402300799)
        .parse(data.messageTimestamp);
      const occurredAt = new Date(seconds * 1000);
      if (occurredAt.getTime() > Date.now() + 300_000)
        throw new Error("QR_EVENT_INVALID");
      let message = object(data.message);
      for (let i = 0; i < 3; i++) {
        const wrapped = object(
          message.ephemeralMessage ??
            message.viewOnceMessage ??
            message.viewOnceMessageV2,
        );
        if (!wrapped.message) break;
        message = object(wrapped.message);
      }
      if (
        message.protocolMessage ||
        message.reactionMessage ||
        message.senderKeyDistributionMessage
      )
        return [];
      const body =
        message.conversation ?? object(message.extendedTextMessage).text;
      if (body === undefined) {
        const kind = (
          ["image", "audio", "video", "document", "sticker"] as const
        ).find((value) => message[value + "Message"]);
        if (kind) {
          const media = object(message[kind + "Message"]);
          return [
            contactEvent({
              kind: key.fromMe === true ? "outbound-media" : "media",
              upstreamMessageId: id.parse(key.id),
              displayName:
                key.fromMe !== true && typeof data.pushName === "string"
                  ? data.pushName.slice(0, 256)
                  : null,
              occurredAt,
              caption:
                typeof media.caption === "string"
                  ? media.caption.slice(0, 1024)
                  : "",
              media: {
                source: "QR",
                sourceKey: id.parse(key.id),
                kind,
                fileName: safeMediaName(
                  typeof media.fileName === "string" ? media.fileName : kind,
                ),
                descriptor: { messageId: id.parse(key.id) },
              },
            }),
          ];
        }
      }
      if (body === undefined) throw new Error("QR_CONTENT_UNSUPPORTED");
      return [
        contactEvent({
          kind: key.fromMe === true ? "outbound" : "message",
          upstreamMessageId: id.parse(key.id),
          displayName:
            key.fromMe !== true && typeof data.pushName === "string"
              ? data.pushName.slice(0, 256)
              : null,
          content: { type: "TEXT", text: text.parse(body) },
          occurredAt,
        }),
      ];
    });
  } catch (error) {
    if (error instanceof Error && error.message === "QR_CONTENT_UNSUPPORTED")
      throw error;
    throw new Error("QR_EVENT_INVALID");
  }
}
