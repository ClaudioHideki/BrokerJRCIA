import { randomUUID } from "node:crypto";
import type { ChatwootStatus } from "@jrc/contracts";
import type {
  OrganizationTransaction,
  TenantTransaction,
} from "../../db/tenant-transaction.js";
import { requireActiveOrganization } from "../tenancy/operational-limits.js";
import { createPostgresMessagingRepository } from "../messaging/repository.js";
import {
  ChatwootClient,
  ChatwootError,
  type ChatwootInbox,
} from "./chatwoot-client.js";
import {
  createIntegrationSecrets,
  verifyChatwootSignature,
} from "./secrets.js";
import { parseChatwootReply } from "./chatwoot-events.js";
import type { MediaStore } from "../messaging/media-store.js";

export class IntegrationError extends Error {
  constructor(
    readonly code: string,
    readonly status = 422,
  ) {
    super(code);
  }
}
export interface ChatwootOptions {
  baseUrl: string;
  publicOrigin: string;
  encryptionKey: string;
  platformToken?: string;
  allowLocal?: boolean;
  fetch?: typeof globalThis.fetch;
  mediaOrigins?: readonly string[];
  media?: MediaStore;
  transact<T>(org: string, operation: OrganizationTransaction<T>): Promise<T>;
  resolveIntegration(id: string): Promise<string | undefined>;
  activateQr?(org: string, instanceId: string): Promise<{ id: string }>;
}
type IntegrationState = "PENDING" | "READY" | "FAILED" | "UNKNOWN" | "DISABLED";
export interface AccountRow {
  organization_id: string;
  base_url: string;
  account_id: string | null;
  encrypted_token: string | null;
  status: IntegrationState;
  last_error: string | null;
}
export interface ConnectionRow {
  id: string;
  organization_id: string;
  channel_id: string;
  inbox_id: string | null;
  name: string;
  encrypted_webhook_secret: string | null;
  status: IntegrationState;
  last_error: string | null;
}
export async function readChatwootAccount(
  tx: TenantTransaction,
  org: string,
): Promise<AccountRow | undefined> {
  return (
    await tx.query<AccountRow>(
      "SELECT organization_id,base_url,account_id,encrypted_token,status,last_error FROM chatwoot_accounts WHERE organization_id=$1",
      [org],
    )
  ).rows[0];
}
export async function readChatwootConnection(
  tx: TenantTransaction,
  org: string,
  id: string,
): Promise<ConnectionRow | undefined> {
  return (
    await tx.query<ConnectionRow>(
      "SELECT id,organization_id,channel_id,inbox_id,name,encrypted_webhook_secret,status,last_error FROM chatwoot_connections WHERE organization_id=$1 AND id=$2",
      [org, id],
    )
  ).rows[0];
}
export async function integrationAudit(
  tx: TenantTransaction,
  org: string,
  action: string,
  resourceId: string | null,
  reason: string,
  actorId?: string,
): Promise<void> {
  await tx.query(
    "INSERT INTO integration_audit(organization_id,actor_id,action,resource_id,reason) VALUES($1,$2,$3,$4,$5)",
    [org, actorId ?? null, action, resourceId, reason],
  );
}
export function chatwootEnvironment(options: ChatwootOptions) {
  const vault = createIntegrationSecrets(options.encryptionKey);
  const origin = new URL(options.baseUrl).origin;
  // Validate configured origins before any credential is sent. Clients cannot choose an arbitrary server.
  new ChatwootClient({
    baseUrl: options.baseUrl,
    token: "configuration-validation",
    allowLocal: options.allowLocal,
  });
  const publicUrl = new URL(options.publicOrigin);
  if (
    publicUrl.origin !== options.publicOrigin ||
    (publicUrl.protocol !== "https:" &&
      !(
        options.allowLocal &&
        publicUrl.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(publicUrl.hostname)
      ))
  )
    throw new Error("INVALID_INTEGRATION_PUBLIC_ORIGIN");
  return {
    vault,
    origin,
    callback: (id: string) =>
      `${options.publicOrigin}/v1/integrations/chatwoot/${id}/events`,
    client(account: AccountRow) {
      if (
        account.base_url !== origin ||
        !account.encrypted_token ||
        !account.account_id ||
        account.status !== "READY"
      )
        throw new IntegrationError("CHATWOOT_ACCOUNT_NOT_READY", 409);
      return new ChatwootClient({
        baseUrl: origin,
        token: vault.decrypt(
          `${account.organization_id}:chatwoot-account`,
          account.encrypted_token,
        ),
        allowLocal: options.allowLocal,
        fetch: options.fetch,
        mediaOrigins: options.mediaOrigins,
      });
    },
  };
}
export function createChatwootService(options: ChatwootOptions) {
  const env = chatwootEnvironment(options);
  const repo = createPostgresMessagingRepository();
  const tx = options.transact;
  function connectionView(row: ConnectionRow) {
    return {
      id: row.id,
      channelId: row.channel_id,
      inboxId: row.inbox_id ? Number(row.inbox_id) : null,
      name: row.name,
      status: row.status,
      lastError: row.last_error,
      webhookUrl: env.callback(row.id),
    };
  }
  async function account(org: string) {
    const row = await tx(org, (t) => readChatwootAccount(t, org));
    if (!row)
      throw new IntegrationError("CHATWOOT_ACCOUNT_NOT_CONFIGURED", 409);
    return row;
  }
  async function rememberInbox(org: string, id: string, remote: ChatwootInbox) {
    // Keep a successful creation ID even when a later verification needs repair.
    await tx(org, (t) =>
      t.query(
        "UPDATE chatwoot_connections SET inbox_id=$3 WHERE organization_id=$1 AND id=$2",
        [org, id, remote.id],
      ),
    );
    if (
      remote.channel_type !== "Channel::Api" ||
      !remote.secret ||
      remote.webhook_url !== env.callback(id)
    )
      throw new IntegrationError("CHATWOOT_WEBHOOK_NOT_READY", 409);
    const encryptedSecret = env.vault.encrypt(
      `${org}:chatwoot-webhook:${id}`,
      remote.secret,
    );
    await tx(org, async (t) => {
      await requireActiveOrganization(t, org);
      await t.query(
        "UPDATE chatwoot_connections SET inbox_id=$3,encrypted_webhook_secret=$4,status='READY',last_error=NULL,updated_at=now() WHERE organization_id=$1 AND id=$2",
        [org, id, remote.id, encryptedSecret],
      );
      await integrationAudit(
        t,
        org,
        "CONNECTION_READY",
        id,
        "API inbox and signed callback configured",
      );
    });
  }
  return {
    async status(org: string) {
      return tx(org, async (t) => {
        const a = await readChatwootAccount(t, org);
        const connections = (
          await t.query<ConnectionRow>(
            "SELECT id,channel_id,inbox_id,name,status,last_error FROM chatwoot_connections WHERE organization_id=$1 ORDER BY created_at DESC",
            [org],
          )
        ).rows;
        const counts = (
          await t.query<{ status: string; count: string }>(
            "SELECT status,count(*)::text AS count FROM integration_jobs WHERE organization_id=$1 GROUP BY status",
            [org],
          )
        ).rows;
        const provisioning =
          (
            await t.query<NonNullable<ChatwootStatus["provisioning"]>>(
              'SELECT stage,state,last_error AS "lastError" FROM chatwoot_provisioning WHERE organization_id=$1',
              [org],
            )
          ).rows[0] ?? null;
        return {
          configured: true,
          baseUrl: env.origin,
          provisioningAvailable: Boolean(options.platformToken),
          provisioning,
          account: a
            ? {
                accountId: a.account_id ? Number(a.account_id) : null,
                status: a.status,
                lastError: a.last_error,
                hasCredential: Boolean(a.encrypted_token),
              }
            : null,
          connections: connections.map(connectionView),
          jobs: Object.fromEntries(
            counts.map((r) => [r.status, Number(r.count)]),
          ),
        };
      });
    },
    async bindAccount(
      org: string,
      input: { accountId: number; token: string },
      actorId?: string,
    ) {
      await tx(org, (t) => requireActiveOrganization(t, org));
      const client = new ChatwootClient({
        baseUrl: env.origin,
        token: input.token,
        allowLocal: options.allowLocal,
        fetch: options.fetch,
      });
      await client.verifyAccount(input.accountId);
      await tx(org, async (t) => {
        await requireActiveOrganization(t, org);
        await t.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('chatwoot-account:'||$1,0))",
          [org],
        );
        const current = await readChatwootAccount(t, org);
        if (
          current &&
          (current.base_url !== env.origin ||
            (current.account_id &&
              Number(current.account_id) !== input.accountId))
        )
          throw new IntegrationError("CHATWOOT_ACCOUNT_ALREADY_BOUND", 409);
        const provisioning = await t.query(
          "SELECT organization_id FROM chatwoot_provisioning WHERE organization_id=$1 AND state<>'READY'",
          [org],
        );
        if (provisioning.rowCount)
          throw new IntegrationError(
            "PROVISIONING_REQUIRES_RECONCILIATION",
            409,
          );
        await t.query(
          `INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,encrypted_token,status) VALUES($1,$2,$3,$4,'READY')
          ON CONFLICT(organization_id) DO UPDATE SET account_id=$3,encrypted_token=$4,status='READY',last_error=NULL,updated_at=now()`,
          [
            org,
            env.origin,
            input.accountId,
            env.vault.encrypt(`${org}:chatwoot-account`, input.token),
          ],
        );
        await integrationAudit(
          t,
          org,
          "ACCOUNT_BOUND",
          null,
          "Chatwoot account access verified",
          actorId,
        );
      });
      return this.status(org);
    },
    async sources(org: string) {
      return tx(org, async (t) => ({
        data: (
          await t.query(
            `
        SELECT 'instance' AS kind,i.id,i.name,'QR Code' AS label FROM instances i
        JOIN provider_accounts p ON p.organization_id=i.organization_id AND p.id=i.provider_account_id
        WHERE i.organization_id=$1 AND p.provider='BAILEYS' AND i.status NOT IN ('PROVISIONING','PROVISIONING_FAILED')
        AND NOT EXISTS(SELECT 1 FROM messaging_channels ch JOIN chatwoot_connections c ON c.organization_id=ch.organization_id AND c.channel_id=ch.id WHERE ch.organization_id=i.organization_id AND ch.instance_id=i.id)
        UNION ALL SELECT 'channel',ch.id,'Número oficial '||ch.phone_number_id,'API oficial Meta' FROM messaging_channels ch
        WHERE ch.organization_id=$1 AND ch.provider='META' AND NOT EXISTS(SELECT 1 FROM chatwoot_connections c WHERE c.organization_id=ch.organization_id AND c.channel_id=ch.id)
        ORDER BY name`,
            [org],
          )
        ).rows,
      }));
    },
    async inboxes(org: string) {
      const a = await account(org);
      return {
        data: (await env.client(a).listInboxes(Number(a.account_id)))
          .filter((i) => i.channel_type === "Channel::Api")
          .map((i) => ({
            id: i.id,
            name: i.name,
            hasWebhook: Boolean(i.webhook_url),
          })),
      };
    },
    async agents(org: string, id: string) {
      const a = await account(org),
        c = await tx(org, (t) => readChatwootConnection(t, org, id));
      if (!c?.inbox_id)
        throw new IntegrationError("INTEGRATION_NOT_FOUND", 404);
      const client = env.client(a);
      const [available, assigned] = await Promise.all([
        client.agents(Number(a.account_id)),
        client.inboxAgents(Number(a.account_id), Number(c.inbox_id)),
      ]);
      return {
        data: available.map((user) => ({
          ...user,
          assigned: assigned.some((member) => member.id === user.id),
        })),
      };
    },
    async addAgents(
      org: string,
      id: string,
      userIds: number[],
      actorId?: string,
    ) {
      const a = await account(org),
        c = await tx(org, (t) => readChatwootConnection(t, org, id));
      if (!c?.inbox_id || !["READY", "DISABLED"].includes(c.status))
        throw new IntegrationError("INTEGRATION_NOT_FOUND", 404);
      const client = env.client(a),
        users = await client.agents(Number(a.account_id));
      if (
        !userIds.length ||
        userIds.some((id) => !users.some((user) => user.id === id))
      )
        throw new IntegrationError("CHATWOOT_AGENT_NOT_IN_ACCOUNT");
      await tx(org, async (t) => {
        await requireActiveOrganization(t, org);
        await integrationAudit(
          t,
          org,
          "INBOX_AGENTS_REQUESTED",
          id,
          "Assign existing account agents to inbox",
          actorId,
        );
      });
      await client.assignAgents(Number(a.account_id), Number(c.inbox_id), [
        ...new Set(userIds),
      ]);
      return this.agents(org, id);
    },
    async connect(
      org: string,
      input: {
        channelId?: string | undefined;
        instanceId?: string | undefined;
        inboxId?: number | undefined;
        name: string;
        replaceExistingWebhook?: boolean | undefined;
      },
      actorId?: string,
    ) {
      const a = await account(org),
        client = env.client(a);
      let channelId = input.channelId;
      if (input.instanceId) {
        if (!options.activateQr)
          throw new IntegrationError("QR_NOT_CONFIGURED", 503);
        channelId = (await options.activateQr(org, input.instanceId)).id;
      }
      if (!channelId) throw new IntegrationError("CHANNEL_REQUIRED", 400);
      const id = randomUUID();
      const connection = await tx(org, async (t) => {
        await requireActiveOrganization(t, org);
        if (!(await repo.findChannel(t, org, channelId!)))
          throw new IntegrationError("CHANNEL_NOT_FOUND", 404);
        const row = (
          await t.query<ConnectionRow>(
            `INSERT INTO chatwoot_connections(id,organization_id,channel_id,name,inbox_id) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(organization_id,channel_id) DO NOTHING RETURNING *`,
            [id, org, channelId, input.name, input.inboxId ?? null],
          )
        ).rows[0];
        if (!row) throw new IntegrationError("CONNECTION_ALREADY_EXISTS", 409);
        await integrationAudit(
          t,
          org,
          "CONNECTION_STARTED",
          id,
          "Requested API inbox binding",
          actorId,
        );
        return row;
      });
      try {
        let remote: ChatwootInbox;
        if (input.inboxId) {
          remote = await client.getInbox(Number(a.account_id), input.inboxId);
          if (remote.channel_type !== "Channel::Api")
            throw new IntegrationError("CHATWOOT_API_INBOX_REQUIRED");
          if (
            remote.webhook_url &&
            remote.webhook_url !== env.callback(connection.id) &&
            !input.replaceExistingWebhook
          )
            throw new IntegrationError(
              "CHATWOOT_WEBHOOK_REPLACEMENT_REQUIRED",
              409,
            );
          await tx(org, (t) =>
            t
              .query(
                "UPDATE chatwoot_connections SET inbox_id=$3 WHERE organization_id=$1 AND id=$2",
                [org, id, input.inboxId],
              )
              .then(() => undefined),
          );
          remote = await client.configureInbox(
            Number(a.account_id),
            input.inboxId,
            env.callback(connection.id),
          );
        } else
          remote = await client.createInbox(
            Number(a.account_id),
            input.name,
            env.callback(connection.id),
          );
        await rememberInbox(org, connection.id, remote);
      } catch (failure) {
        const uncertain =
          !(failure instanceof IntegrationError) &&
          (!(failure instanceof ChatwootError) || failure.uncertain);
        const code =
          failure instanceof IntegrationError ||
          failure instanceof ChatwootError
            ? failure.code
            : "CHATWOOT_CONFIGURATION_UNKNOWN";
        await tx(org, (t) =>
          t
            .query(
              "UPDATE chatwoot_connections SET status=$3,last_error=$4,updated_at=now() WHERE organization_id=$1 AND id=$2",
              [org, id, uncertain ? "UNKNOWN" : "FAILED", code],
            )
            .then(() => undefined),
        );
        throw failure;
      }
      return this.status(org);
    },
    async reconcileConnection(org: string, id: string) {
      const a = await account(org),
        client = env.client(a);
      const c = await tx(org, (t) => readChatwootConnection(t, org, id));
      if (!c) throw new IntegrationError("INTEGRATION_NOT_FOUND", 404);
      const matches = (await client.listInboxes(Number(a.account_id))).filter(
        (i) => i.webhook_url === env.callback(id),
      );
      if (matches.length !== 1)
        throw new IntegrationError(
          "CHATWOOT_INBOX_RECONCILIATION_REQUIRED",
          409,
        );
      await rememberInbox(
        org,
        id,
        await client.getInbox(Number(a.account_id), matches[0]!.id),
      );
      return this.status(org);
    },
    async retryConnection(
      org: string,
      id: string,
      replaceExistingWebhook: boolean,
      actorId?: string,
    ) {
      const a = await account(org),
        client = env.client(a);
      const c = await tx(org, async (t) => {
        await requireActiveOrganization(t, org);
        const row = (
          await t.query<ConnectionRow>(
            "UPDATE chatwoot_connections SET status='PENDING',updated_at=now() WHERE organization_id=$1 AND id=$2 AND status='FAILED' RETURNING *",
            [org, id],
          )
        ).rows[0];
        if (!row)
          throw new IntegrationError(
            "CHATWOOT_INBOX_RECONCILIATION_REQUIRED",
            409,
          );
        await integrationAudit(
          t,
          org,
          "CONNECTION_RETRIED",
          id,
          "Operator requested configuration retry",
          actorId,
        );
        return row;
      });
      try {
        let remote: ChatwootInbox;
        if (c.inbox_id) {
          const existing = await client.getInbox(
            Number(a.account_id),
            Number(c.inbox_id),
          );
          if (existing.channel_type !== "Channel::Api")
            throw new IntegrationError("CHATWOOT_API_INBOX_REQUIRED");
          if (
            existing.webhook_url &&
            existing.webhook_url !== env.callback(id) &&
            !replaceExistingWebhook
          )
            throw new IntegrationError(
              "CHATWOOT_WEBHOOK_REPLACEMENT_REQUIRED",
              409,
            );
          remote = await client.configureInbox(
            Number(a.account_id),
            Number(c.inbox_id),
            env.callback(id),
          );
        } else
          remote = await client.createInbox(
            Number(a.account_id),
            c.name,
            env.callback(id),
          );
        await rememberInbox(org, id, remote);
      } catch (failure) {
        const uncertain =
          !(failure instanceof IntegrationError) &&
          (!(failure instanceof ChatwootError) || failure.uncertain);
        const code =
          failure instanceof IntegrationError ||
          failure instanceof ChatwootError
            ? failure.code
            : "CHATWOOT_CONFIGURATION_UNKNOWN";
        await tx(org, (t) =>
          t.query(
            "UPDATE chatwoot_connections SET status=$3,last_error=$4,updated_at=now() WHERE organization_id=$1 AND id=$2",
            [org, id, uncertain ? "UNKNOWN" : "FAILED", code],
          ),
        );
        throw failure;
      }
      return this.status(org);
    },
    async setEnabled(
      org: string,
      id: string,
      enabled: boolean,
      actorId?: string,
    ) {
      await tx(org, async (t) => {
        await requireActiveOrganization(t, org);
        const c = await readChatwootConnection(t, org, id);
        if (!c) throw new IntegrationError("INTEGRATION_NOT_FOUND", 404);
        if (enabled && (!c.inbox_id || !c.encrypted_webhook_secret))
          throw new IntegrationError("CHATWOOT_WEBHOOK_NOT_READY", 409);
        await t.query(
          "UPDATE chatwoot_connections SET status=$3,updated_at=now() WHERE organization_id=$1 AND id=$2",
          [org, id, enabled ? "READY" : "DISABLED"],
        );
        await integrationAudit(
          t,
          org,
          enabled ? "CONNECTION_RESUMED" : "CONNECTION_PAUSED",
          id,
          "Operator changed integration state",
          actorId,
        );
      });
      return this.status(org);
    },
    async ingest(
      id: string,
      raw: Buffer,
      timestamp: string | undefined,
      signature: string | undefined,
    ) {
      const org = await options.resolveIntegration(id);
      if (!org) throw new IntegrationError("INVALID_WEBHOOK_SIGNATURE", 401);
      await tx(org, async (t) => {
        const c = await readChatwootConnection(t, org, id),
          a = await readChatwootAccount(t, org);
        if (!c?.encrypted_webhook_secret || !c.inbox_id || !a?.account_id)
          throw new IntegrationError("INVALID_WEBHOOK_SIGNATURE", 401);
        const secret = env.vault.decrypt(
          `${org}:chatwoot-webhook:${id}`,
          c.encrypted_webhook_secret,
        );
        if (!verifyChatwootSignature(secret, raw, timestamp, signature))
          throw new IntegrationError("INVALID_WEBHOOK_SIGNATURE", 401);
        let payload: unknown;
        try {
          payload = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(raw),
          );
        } catch {
          throw new IntegrationError("INVALID_WEBHOOK_PAYLOAD", 400);
        }
        const eventName =
          typeof payload === "object" && payload !== null && "event" in payload
            ? payload.event
            : undefined;
        if (eventName !== "message_created") return;
        const reply = parseChatwootReply(payload, {
          accountId: Number(a.account_id),
          inboxId: Number(c.inbox_id),
        });
        if (!reply) return;
        await t.query(
          `INSERT INTO integration_jobs(organization_id,integration_id,kind,dedupe_key,payload)
          VALUES($1,$2,'CHATWOOT_REPLY',$3,$4::jsonb) ON CONFLICT(organization_id,integration_id,dedupe_key) DO NOTHING`,
          [org, id, `reply:${reply.messageId}`, JSON.stringify(reply)],
        );
      });
    },
    async jobs(org: string) {
      return tx(org, async (t) => ({
        data: (
          await t.query(
            `SELECT id,integration_id AS "integrationId",kind,status,attempts,last_error AS "lastError",payload->>'operation' AS operation,message_id AS "messageId",created_at AS "createdAt",updated_at AS "updatedAt"
        FROM integration_jobs WHERE organization_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`,
            [org],
          )
        ).rows.map((row) => ({
          ...row,
          createdAt: new Date(row.createdAt).toISOString(),
          updatedAt: new Date(row.updatedAt).toISOString(),
        })),
      }));
    },
    async retryJob(org: string, id: string, reason: string, actorId?: string) {
      await tx(org, async (t) => {
        await requireActiveOrganization(t, org);
        const result = await t.query(
          `UPDATE integration_jobs SET status='PENDING',attempts=0,available_at=now(),last_error=NULL,updated_at=now()
          WHERE organization_id=$1 AND id=$2 AND status='FAILED' RETURNING id,message_id`,
          [org, id],
        );
        if (!result.rowCount)
          throw new IntegrationError("JOB_REQUIRES_RECONCILIATION", 409);
        await t.query(
          `UPDATE messaging_media SET status='PENDING',attempts=0,available_at=now(),last_error=NULL,updated_at=now() WHERE organization_id=$1 AND status='FAILED' AND id IN (SELECT media_id FROM messaging_messages WHERE organization_id=$1 AND id=$2)`,
          [org, result.rows[0]?.message_id],
        );
        await integrationAudit(t, org, "JOB_RETRIED", id, reason, actorId);
      });
      return { ok: true as const };
    },
    async reconcileJob(
      org: string,
      id: string,
      reason: string,
      remoteId?: number,
      actorId?: string,
    ) {
      const context = await tx(org, async (t) => {
        await requireActiveOrganization(t, org);
        const job = (
          await t.query<{
            id: string;
            integration_id: string;
            message_id: string;
            kind: string;
            status: string;
            payload: Record<string, unknown>;
          }>(
            "SELECT * FROM integration_jobs WHERE organization_id=$1 AND id=$2 AND status='UNKNOWN'",
            [org, id],
          )
        ).rows[0];
        if (!job || job.kind !== "MIRROR_MESSAGE")
          throw new IntegrationError("JOB_REQUIRES_RECONCILIATION", 409);
        const a = await readChatwootAccount(t, org),
          c = await readChatwootConnection(t, org, job.integration_id);
        if (!a || !c?.inbox_id)
          throw new IntegrationError("INTEGRATION_NOT_FOUND", 404);
        const contact = (
          await t.query<{ external_id: string }>(
            `SELECT contact.external_id FROM messaging_messages m
          JOIN messaging_conversations conversation ON conversation.organization_id=m.organization_id AND conversation.id=m.conversation_id
          JOIN messaging_contacts contact ON contact.organization_id=conversation.organization_id AND contact.id=conversation.contact_id
          WHERE m.organization_id=$1 AND m.id=$2`,
            [org, job.message_id],
          )
        ).rows[0];
        if (!contact)
          throw new IntegrationError("INTEGRATION_MESSAGE_NOT_FOUND", 404);
        return { job, a, c, contact };
      });
      const { job, a, c, contact } = context,
        client = env.client(a),
        accountId = Number(a.account_id),
        inboxId = Number(c.inbox_id);
      const patch: Record<string, unknown> = {};
      switch (job.payload.operation) {
        case "CREATE_CONTACT": {
          const found = await client.findContact(
            accountId,
            contact.external_id,
          );
          if (!found)
            throw new IntegrationError("CHATWOOT_CONTACT_NOT_CONFIRMED", 409);
          patch.contactId = found;
          break;
        }
        case "LINK_CONTACT": {
          const found = await client.contact(
            accountId,
            Number(job.payload.contactId),
          );
          if (found.phone_number?.replace(/\D/g, "") !== contact.external_id)
            throw new IntegrationError("CHATWOOT_CONTACT_NOT_CONFIRMED", 409);
          const inbox = found.contact_inboxes.filter(
            (i) => i.inbox.id === inboxId,
          );
          if (inbox.length !== 1)
            throw new IntegrationError("CHATWOOT_CONTACT_NOT_CONFIRMED", 409);
          patch.sourceId = inbox[0]!.source_id;
          break;
        }
        case "CREATE_CONVERSATION": {
          if (!remoteId)
            throw new IntegrationError(
              "CHATWOOT_CONVERSATION_ID_REQUIRED",
              409,
            );
          const found = await client.conversation(accountId, remoteId);
          if (
            found.account_id !== accountId ||
            found.inbox_id !== inboxId ||
            found.meta.sender.id !== Number(job.payload.contactId) ||
            found.meta.sender.phone_number?.replace(/\D/g, "") !==
              contact.external_id
          )
            throw new IntegrationError("CHATWOOT_CONVERSATION_MISMATCH", 409);
          patch.conversationId = found.id;
          break;
        }
        case "SEND_MESSAGE": {
          const found = await client.findBrokerMessage(
            accountId,
            Number(job.payload.conversationId),
            job.message_id,
            remoteId,
          );
          if (!found)
            throw new IntegrationError("CHATWOOT_MESSAGE_NOT_CONFIRMED", 409);
          patch.remoteMessageId = found;
          break;
        }
        case "UPDATE_STATUS":
          break; // Status PATCH is idempotent and can be repeated.
        default:
          throw new IntegrationError("JOB_REQUIRES_RECONCILIATION", 409);
      }
      await tx(org, async (t) => {
        await requireActiveOrganization(t, org);
        const result = await t.query(
          `UPDATE integration_jobs SET status='PENDING',payload=payload||$3::jsonb,last_error=NULL,available_at=now(),updated_at=now()
          WHERE organization_id=$1 AND id=$2 AND status='UNKNOWN' RETURNING id`,
          [org, id, JSON.stringify(patch)],
        );
        if (!result.rowCount)
          throw new IntegrationError("JOB_REQUIRES_RECONCILIATION", 409);
        await integrationAudit(t, org, "JOB_RECONCILED", id, reason, actorId);
      });
      return { ok: true as const };
    },
  };
}
export type ChatwootService = ReturnType<typeof createChatwootService>;
