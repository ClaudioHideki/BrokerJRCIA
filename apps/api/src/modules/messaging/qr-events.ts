import { z } from "zod";
import type { MessageContent } from "./types.js";
import type { MediaRegistration } from "./media-store.js";
import { safeMediaName } from "@jrc/providers";

export type QrEvent =
  | { kind: "connection"; state: "CONNECTED" | "DISCONNECTED"; identity?: string }
  | {
      kind: "message";
      upstreamMessageId: string;
      externalId: string;
      displayName: string | null;
      content: MessageContent;
      occurredAt: Date;
    }
  | {
      kind: "media";
      upstreamMessageId: string;
      externalId: string;
      displayName: string | null;
      media: MediaRegistration;
      caption: string;
      occurredAt: Date;
    }
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
function phone(jid: unknown): string | undefined {
  if (typeof jid !== "string") return;
  return /^([1-9]\d{7,14})(?::\d+)?@s\.whatsapp\.net$/u.exec(jid)?.[1];
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
  if (event === "connection.update") {
    const data = object(envelope.data), state = data.state, identity = phone(data.wuid);
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
      if (
        key.fromMe === true ||
        typeof key.remoteJid !== "string" ||
        /@(g\.us|broadcast|newsletter)$/u.test(key.remoteJid)
      )
        return [];
      const externalId = phone(key.remoteJid) ?? phone(key.remoteJidAlt);
      if (!externalId) throw new Error("QR_EVENT_INVALID");
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
            {
              kind: "media",
              upstreamMessageId: id.parse(key.id),
              externalId,
              displayName:
                typeof data.pushName === "string"
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
            },
          ];
        }
      }
      if (body === undefined) throw new Error("QR_CONTENT_UNSUPPORTED");
      return [
        {
          kind: "message",
          upstreamMessageId: id.parse(key.id),
          externalId,
          displayName:
            typeof data.pushName === "string"
              ? data.pushName.slice(0, 256)
              : null,
          content: { type: "TEXT", text: text.parse(body) },
          occurredAt,
        },
      ];
    });
  } catch (error) {
    if (error instanceof Error && error.message === "QR_CONTENT_UNSUPPORTED")
      throw error;
    throw new Error("QR_EVENT_INVALID");
  }
}
