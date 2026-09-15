import { z } from "zod";
const event = z.object({
  event: z.string(),
  id: z.number().int().positive(),
  account: z.object({ id: z.number().int().positive() }),
  inbox: z.object({ id: z.number().int().positive() }),
  conversation: z.object({
    id: z.number().int().positive(),
    inbox_id: z.number().int().positive().optional(),
  }),
  message_type: z.union([z.string(), z.number()]),
  private: z.boolean(),
  content: z.string().nullable().optional(),
  content_attributes: z.record(z.string(), z.unknown()).optional(),
  attachments: z.array(z.unknown()).optional(),
});
export function parseChatwootReply(
  raw: unknown,
  binding: { accountId: number; inboxId: number },
) {
  const message = event.parse(raw);
  if (
    message.account.id !== binding.accountId ||
    message.inbox.id !== binding.inboxId ||
    (message.conversation.inbox_id !== undefined &&
      message.conversation.inbox_id !== binding.inboxId)
  )
    throw new Error("CHATWOOT_BINDING_MISMATCH");
  if (
    message.event !== "message_created" ||
    !["outgoing", 1].includes(message.message_type) ||
    message.private ||
    message.content_attributes?.jrc_broker_message_id
  )
    return null;
  if (message.attachments?.length) {
    const attachments = z
      .array(
        z.object({
          id: z.number().int().positive(),
          file_type: z.enum(["image", "audio", "video", "file"]),
        }),
      )
      .max(10)
      .parse(message.attachments)
      .map((item) => ({
        id: item.id,
        kind:
          item.file_type === "file" ? ("document" as const) : item.file_type,
      }));
    if (new Set(attachments.map((a) => a.id)).size !== attachments.length)
      throw new Error("CHATWOOT_ATTACHMENT_DUPLICATE");
    return {
      messageId: message.id,
      conversationId: message.conversation.id,
      attachments,
      caption: z
        .string()
        .max(4096)
        .parse(message.content ?? ""),
    };
  }
  const content = z.string().min(1).max(4096).parse(message.content);
  return {
    messageId: message.id,
    conversationId: message.conversation.id,
    content: { type: "TEXT" as const, text: content },
  };
}
