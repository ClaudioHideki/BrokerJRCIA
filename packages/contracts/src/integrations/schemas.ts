import { z } from "zod";
export const IntegrationStateSchema = z.enum([
  "PENDING",
  "READY",
  "FAILED",
  "UNKNOWN",
  "DISABLED",
]);
export const IntegrationConnectionSchema = z.object({
  id: z.uuid(),
  channelId: z.uuid(),
  inboxId: z.number().int().positive().nullable(),
  name: z.string(),
  status: IntegrationStateSchema,
  lastError: z.string().nullable(),
  webhookUrl: z.url(),
});
export const ChatwootStatusSchema = z.object({
  configured: z.boolean(),
  baseUrl: z.url().nullable(),
  provisioningAvailable: z.boolean(),
  provisioning: z
    .object({
      stage: z.enum(["ACCOUNT", "USER", "ACCESS", "VERIFY", "DONE"]),
      state: z.enum(["PENDING", "RUNNING", "FAILED", "UNKNOWN", "READY"]),
      lastError: z.string().nullable(),
    })
    .nullable()
    .optional(),
  account: z
    .object({
      accountId: z.number().int().positive().nullable(),
      status: IntegrationStateSchema,
      lastError: z.string().nullable(),
      hasCredential: z.boolean(),
    })
    .nullable(),
  connections: z.array(IntegrationConnectionSchema),
  jobs: z.record(z.string(), z.number().int().nonnegative()),
});
export const BindChatwootAccountSchema = z.strictObject({
  accountId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  token: z
    .string()
    .min(8)
    .max(4096)
    .regex(/^[^\r\n]+$/u),
});
export const ConnectChatwootSchema = z
  .strictObject({
    channelId: z.uuid().optional(),
    instanceId: z.uuid().optional(),
    inboxId: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(120),
    replaceExistingWebhook: z.boolean().optional(),
  })
  .refine(
    (v) => Boolean(v.channelId) !== Boolean(v.instanceId),
    "Choose one connection",
  );
export const IntegrationJobsSchema = z.object({
  data: z.array(
    z.object({
      id: z.uuid(),
      integrationId: z.uuid(),
      kind: z.enum(["CHATWOOT_REPLY", "MIRROR_MESSAGE"]),
      status: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "UNKNOWN"]),
      attempts: z.number().int().nonnegative(),
      lastError: z.string().nullable(),
      operation: z.enum(['CREATE_CONTACT','LINK_CONTACT','CREATE_CONVERSATION','SEND_MESSAGE','UPDATE_STATUS']).nullable().optional(),
      messageId: z.uuid().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
});
export type ChatwootStatus = z.infer<typeof ChatwootStatusSchema>;
export const ReconcileIntegrationJobSchema = z.strictObject({
  reason: z.string().trim().min(5).max(500),
  remoteId: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER - 1)
    .optional(),
});
export type IntegrationJob = z.infer<
  typeof IntegrationJobsSchema
>["data"][number];
