import { z } from "zod";
export const SendTextRequestSchema = z.strictObject({
  conversationId: z.uuid(),
  text: z.string().trim().min(1).max(4096),
});
export type SendTextRequest = z.infer<typeof SendTextRequestSchema>;

export const SendTemplateRequestSchema = z.strictObject({
  conversationId: z.uuid(),
  name: z.string().regex(/^[a-z0-9_]{1,512}$/),
  language: z.string().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/),
  variables: z.array(z.string().max(1024)).max(100).default([]),
});
export const ConfigureBotRequestSchema = z.strictObject({
  publicId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  originReference: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
});
export const ConversationModeRequestSchema = z.strictObject({
  mode: z.enum(["BOT", "HUMAN"]),
});
export const MessagingChannelViewSchema = z.object({
  id: z.uuid(),
  provider: z.enum(["META", "BAILEYS"]),
  botPublicId: z.string().nullable(),
});
export const MessagingChannelsResponseSchema = z.object({
  data: z.array(MessagingChannelViewSchema),
});
export const TemplateViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  language: z.string(),
  status: z.string(),
  category: z.string(),
  bodyVariableCount: z.number().int().min(0).max(100).nullable(),
});
export const TemplatesResponseSchema = z.object({
  data: z.array(TemplateViewSchema),
});
export const ConversationViewSchema = z.object({
  id: z.uuid(),
  channelId: z.uuid(),
  contactId: z.uuid(),
  mode: z.enum(["BOT", "HUMAN"]),
});
export const ConversationsResponseSchema = z.object({
  data: z.array(ConversationViewSchema),
});
export const MessageViewSchema = z.object({
  id: z.uuid(),
  direction: z.enum(["INCOMING", "OUTGOING"]),
  state: z.enum([
    "ACCEPTED",
    "SENDING",
    "SENT",
    "DELIVERED",
    "READ",
    "FAILED",
    "UNKNOWN",
  ]),
  text: z.string(),
  media: z
    .object({
      id: z.uuid(),
      kind: z.enum(["image", "audio", "video", "document", "sticker"]),
      fileName: z.string(),
    })
    .optional(),
  errorCode: z.string().nullable().optional(),
  retrySafe: z.boolean().optional(),
});
export const MessagesResponseSchema = z.object({
  data: z.array(MessageViewSchema),
});
export type SendTemplateRequest = z.infer<typeof SendTemplateRequestSchema>;
export type ConfigureBotRequest = z.infer<typeof ConfigureBotRequestSchema>;
export type MessagingChannelView = z.infer<typeof MessagingChannelViewSchema>;
export type TemplateView = z.infer<typeof TemplateViewSchema>;
export type ConversationView = z.infer<typeof ConversationViewSchema>;
export type MessageView = z.infer<typeof MessageViewSchema>;
