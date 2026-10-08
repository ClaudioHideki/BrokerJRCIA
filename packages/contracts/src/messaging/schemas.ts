import { z } from "zod";
export const SendTextRequestSchema = z.strictObject({
  conversationId: z.uuid(),
  text: z.string().trim().min(1).max(4096),
});
export type SendTextRequest = z.infer<typeof SendTextRequestSchema>;

export const QrOutboundObservationViewSchema = z.strictObject({
  id:z.uuid(),revision:z.number().int().positive(),blocking:z.boolean(),
  disposition:z.enum(['RECONCILE','ABANDONED']),
  reason:z.enum(['QR_ACK_PENDING','QR_PROVIDER_ID_CONFLICT','QR_ABANDONED_ATTEMPT_UNRESOLVED','QR_OBSERVATION_ABANDONED','QR_LIFECYCLE_RECONCILE']),
  attempts:z.array(z.strictObject({id:z.uuid(),messageId:z.uuid(),state:z.enum(['DISPATCHED','UNKNOWN','ABANDONED'])})),
});
export type QrOutboundObservationView=z.infer<typeof QrOutboundObservationViewSchema>;
export const QrOutboundObservationsResponseSchema=z.strictObject({data:z.array(QrOutboundObservationViewSchema)});
export const AbandonQrOutboundObservationRequestSchema=z.strictObject({
  expectedRevision:z.number().int().positive(),attemptIds:z.array(z.uuid()).max(100).refine(ids=>new Set(ids).size===ids.length),
  reason:z.string().trim().min(5).max(500),
});
export type AbandonQrOutboundObservationRequest=z.infer<typeof AbandonQrOutboundObservationRequestSchema>;
export const QrDispatchAttemptViewSchema=z.strictObject({
  id:z.uuid(),messageId:z.uuid(),revision:z.number().int().positive(),state:z.enum(['DISPATCHED','UNKNOWN','ABANDONED']),
});
export type QrDispatchAttemptView=z.infer<typeof QrDispatchAttemptViewSchema>;
export const QrDispatchAttemptsResponseSchema=z.strictObject({data:z.array(QrDispatchAttemptViewSchema)});
export const AbandonQrDispatchAttemptRequestSchema=z.strictObject({expectedRevision:z.number().int().positive(),reason:z.string().trim().min(5).max(500)});
export type AbandonQrDispatchAttemptRequest=z.infer<typeof AbandonQrDispatchAttemptRequestSchema>;

export const SendTemplateRequestSchema = z.strictObject({
  conversationId: z.uuid(),
  name: z.string().regex(/^[a-z0-9_]{1,512}$/),
  language: z.string().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/),
  variables: z.array(z.string().max(1024)).max(100).default([]),
});
export const ConfigureBotRequestSchema = z.strictObject({
  expectedOwnerRevision: z.number().int().nonnegative(),
  publicId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  originReference: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
});
export const ConversationModeRequestSchema = z.strictObject({
  mode: z.enum(["BOT", "HUMAN"]),
});
export const MessagingChannelViewSchema = z.object({
  ownerRevision: z.number().int().nonnegative(),
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
export const TemplateStatusResponseSchema = z.discriminatedUnion("observation", [
  z.strictObject({
    observation: z.literal("OBSERVED"),
    id: z.string().regex(/^[1-9]\d{4,63}$/),
    checkedAt: z.iso.datetime(),
    template: TemplateViewSchema,
  }),
  z.strictObject({
    observation: z.literal("NOT_OBSERVED"),
    id: z.string().regex(/^[1-9]\d{4,63}$/),
    checkedAt: z.iso.datetime(),
  }),
]);
/** First commercial submission supports a fixed text BODY without variables. */
export const CreateTextTemplateRequestSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9_]{1,512}$/),
  language: z.string().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/),
  category: z.enum(["UTILITY", "MARKETING"]),
  body: z.string().trim().min(1).max(1024).refine(value => !/\{\{|\}\}/u.test(value)),
});
export const SubmittedTemplateSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  language: z.string(),
  category: z.string(),
  status: z.string(),
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
  source: z.enum(["CONTACT", "OPERATOR", "AUTOMATION", "EXTERNAL_OBSERVED"]).optional(),
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
export type TemplateStatusResponse = z.infer<typeof TemplateStatusResponseSchema>;
export type CreateTextTemplateRequest = z.infer<typeof CreateTextTemplateRequestSchema>;
export type SubmittedTemplate = z.infer<typeof SubmittedTemplateSchema>;
export type ConversationView = z.infer<typeof ConversationViewSchema>;
export type MessageView = z.infer<typeof MessageViewSchema>;
