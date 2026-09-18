export type ConversationMode = "BOT" | "HUMAN";
export type ConsentStatus = "UNKNOWN" | "OPTED_IN" | "OPTED_OUT";
export type MessageDirection = "INCOMING" | "OUTGOING";
export type OutgoingMessageSource = "OPERATOR" | "AUTOMATION";
export type MessageSource = OutgoingMessageSource | "CONTACT";
export type MessageState =
  | "ACCEPTED"
  | "SENDING"
  | "SENT"
  | "DELIVERED"
  | "READ"
  | "FAILED"
  | "UNKNOWN";

export interface TextMessageContent {
  type: "TEXT";
  text: string;
}

export interface TemplateMessageContent {
  type: "TEMPLATE";
  name: string;
  language: string;
  variables: string[];
}

export interface MediaMessageContent {
  type: "MEDIA";
  mediaId: string;
  kind: "image" | "audio" | "video" | "document" | "sticker";
  fileName: string;
  caption?: string;
}
export type MessageContent =
  | TextMessageContent
  | TemplateMessageContent
  | MediaMessageContent;

export interface MessagingChannel {
  id: string;
  organizationId: string;
  providerAccountId: string;
  /** Absent only in legacy in-process consumers; persisted channels always have a provider. */
  provider?: "META" | "BAILEYS";
  instanceId?: string | null;
  phoneNumberId: string | null;
  wabaId: string | null;
  credentialReference: string;
  botPublicId: string | null;
  botOriginReference: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessagingContact {
  id: string;
  organizationId: string;
  externalId: string;
  displayName: string | null;
  consentStatus: ConsentStatus;
  consentUpdatedAt: Date | null;
  suppressedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Conversation {
  id: string;
  organizationId: string;
  channelId: string;
  contactId: string;
  mode: ConversationMode;
  botPublicId: string | null;
  botOriginReference: string | null;
  typebotSessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationListItem extends Conversation {
  contact: MessagingContact;
  lastMessageAt: Date | null;
}

export interface Message {
  retrySafe?: boolean;
  id: string;
  organizationId: string;
  channelId: string;
  conversationId: string;
  direction: MessageDirection;
  source: MessageSource;
  upstreamMessageId: string | null;
  content: MessageContent;
  state: MessageState;
  canonicalErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OutboxClaim {
  message: Message;
  contact: MessagingContact;
  channel: MessagingChannel;
  leaseToken: string;
  attemptCount: number;
}

export type ClaimIneligibilityReason =
  | "FLOW_REVOKED"
  | "IDENTITY_CONFIRMATION_REQUIRED"
  | "ORGANIZATION_NOT_ACTIVE"
  | "META_CHANNEL_NOT_READY"
  | "QR_CHANNEL_DISCONNECTED"
  | "CONTACT_SUPPRESSED"
  | "CONTACT_CONSENT_REQUIRED"
  | "CUSTOMER_SERVICE_WINDOW_CLOSED"
  | "CONVERSATION_PAUSED"
  | "INVALID_OUTBOX_CLAIM";

export type ClaimValidation =
  | { eligible: true; claim: OutboxClaim }
  | { eligible: false; reason: ClaimIneligibilityReason };

export interface BotTurnClaim {
  message: Message;
  conversation: Conversation;
  contact: MessagingContact;
  channel: MessagingChannel;
  leaseToken: string;
}

export type BotTurnCompletion =
  | { kind: "completed"; messages: Message[] }
  | { kind: "paused"; messages: [] };

export type CompleteSendOutcome =
  | { state: "SENT"; upstreamMessageId: string }
  | { state: "FAILED"; canonicalErrorCode: string; retrySafe: boolean }
  | { state: "UNKNOWN"; canonicalErrorCode: string };
