import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireActiveOrganization } from "../tenancy/operational-limits.js";
import { ChatwootClient, ChatwootError } from "./chatwoot-client.js";
import {
  chatwootEnvironment,
  IntegrationError,
  integrationAudit,
  readChatwootAccount,
  type ChatwootOptions,
} from "./chatwoot-service.js";

export const ProvisionChatwootInput = z.strictObject({
  name: z.string().trim().min(1).max(120),
  email: z.email().toLowerCase().max(254),
  password: z
    .string()
    .min(12)
    .max(128)
    .regex(/[A-Z]/)
    .regex(/[a-z]/)
    .regex(/[0-9]/)
    .regex(/[^A-Za-z0-9]/),
});
type Input = z.infer<typeof ProvisionChatwootInput>;
interface ProvisionRow {
  stage: "ACCOUNT" | "USER" | "ACCESS" | "VERIFY" | "DONE";
  state: "PENDING" | "RUNNING" | "FAILED" | "UNKNOWN" | "READY";
  encrypted_input: string | null;
  remote_user_id: string | null;
  lease_token: string | null;
  last_error: string | null;
}
export function createChatwootProvisioner(options: ChatwootOptions) {
  const env = chatwootEnvironment(options),
    tx = options.transact;
  const platform = () => {
    if (!options.platformToken)
      throw new IntegrationError("CHATWOOT_PLATFORM_NOT_CONFIGURED", 503);
    return new ChatwootClient({
      baseUrl: env.origin,
      token: options.platformToken,
      fetch: options.fetch,
      allowLocal: options.allowLocal,
    });
  };
  const read = (org: string) =>
    tx(
      org,
      async (t) =>
        (
          await t.query<ProvisionRow>(
            "SELECT * FROM chatwoot_provisioning WHERE organization_id=$1",
            [org],
          )
        ).rows[0],
    );
  async function claim(org: string, reconcile: boolean) {
    // An expired creation request may have succeeded remotely. It must be inspected, never repeated automatically.
    await tx(org, (t) =>
      t.query(
        "UPDATE chatwoot_provisioning SET state='UNKNOWN',last_error='PROVISIONING_INTERRUPTED',lease_token=NULL,lease_expires_at=NULL WHERE organization_id=$1 AND state='RUNNING' AND lease_expires_at<now()",
        [org],
      ),
    );
    return tx(org, async (t) => {
      await requireActiveOrganization(t, org);
      const row = (
        await t.query<ProvisionRow>(
          "SELECT * FROM chatwoot_provisioning WHERE organization_id=$1 FOR UPDATE",
          [org],
        )
      ).rows[0];
      if (!row) throw new IntegrationError("PROVISIONING_NOT_FOUND", 404);
      if (row.state === "READY") return undefined;
      if (row.state === "RUNNING")
        throw new IntegrationError("PROVISIONING_IN_PROGRESS", 409);
      if (row.state === "UNKNOWN" && !reconcile)
        throw new IntegrationError("PROVISIONING_REQUIRES_RECONCILIATION", 409);
      const lease = randomUUID();
      await t.query(
        "UPDATE chatwoot_provisioning SET state='RUNNING',lease_token=$2,lease_expires_at=now()+interval '2 minutes',updated_at=now() WHERE organization_id=$1",
        [org, lease],
      );
      return { ...row, lease_token: lease };
    });
  }
  async function progress(
    org: string,
    lease: string,
    stage: ProvisionRow["stage"],
    accountId?: number,
    user?: { id: number; token: string },
  ) {
    await tx(org, async (t) => {
      await requireActiveOrganization(t, org);
      const result = await t.query(
        `UPDATE chatwoot_provisioning SET stage=$3,state=$4,remote_user_id=coalesce($5,remote_user_id),last_error=NULL,
        encrypted_input=CASE WHEN $3='DONE' THEN NULL ELSE encrypted_input END,
        lease_token=CASE WHEN $3='DONE' THEN NULL ELSE lease_token END,lease_expires_at=CASE WHEN $3='DONE' THEN NULL ELSE now()+interval '2 minutes' END,updated_at=now()
        WHERE organization_id=$1 AND lease_token=$2 AND state='RUNNING' AND lease_expires_at>now() RETURNING organization_id`,
        [
          org,
          lease,
          stage,
          stage === "DONE" ? "READY" : "RUNNING",
          user?.id ?? null,
        ],
      );
      if (!result.rowCount)
        throw new IntegrationError("PROVISIONING_LEASE_LOST", 409);
      await t.query(
        `UPDATE chatwoot_accounts SET account_id=coalesce($2,account_id),encrypted_token=coalesce($3,encrypted_token),status=$4,last_error=NULL,updated_at=now() WHERE organization_id=$1`,
        [
          org,
          accountId ?? null,
          user
            ? env.vault.encrypt(`${org}:chatwoot-account`, user.token)
            : null,
          stage === "DONE" ? "READY" : "PENDING",
        ],
      );
      await integrationAudit(
        t,
        org,
        "PROVISIONING_" + stage,
        null,
        "Persisted account provisioning step",
      );
    });
  }
  async function failed(org: string, lease: string, failure: unknown) {
    const uncertain =
      !(failure instanceof IntegrationError) &&
      (!(failure instanceof ChatwootError) || failure.uncertain);
    const code =
      failure instanceof IntegrationError || failure instanceof ChatwootError
        ? failure.code
        : "PROVISIONING_OUTCOME_UNKNOWN";
    await tx(org, async (t) => {
      const changed = await t.query(
        "UPDATE chatwoot_provisioning SET state=$3,last_error=$4,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE organization_id=$1 AND lease_token=$2 RETURNING organization_id",
        [org, lease, uncertain ? "UNKNOWN" : "FAILED", code],
      );
      if (changed.rowCount)
        await t.query(
          "UPDATE chatwoot_accounts SET status=$2,last_error=$3 WHERE organization_id=$1",
          [org, uncertain ? "UNKNOWN" : "FAILED", code],
        );
    });
  }
  async function execute(org: string, row: ProvisionRow) {
    const client = platform(),
      lease = row.lease_token!;
    let externalPending = false;
    const beforeExternal = () =>
      tx(org, async (t) => {
        await requireActiveOrganization(t, org);
        if (
          !(
            await t.query(
              "SELECT 1 FROM chatwoot_provisioning WHERE organization_id=$1 AND lease_token=$2 AND state='RUNNING' AND lease_expires_at>now()+interval '20 seconds'",
              [org, lease],
            )
          ).rowCount
        )
          throw new IntegrationError("PROVISIONING_LEASE_LOST", 409);
      });
    try {
      const input = ProvisionChatwootInput.parse(
        JSON.parse(
          env.vault.decrypt(
            `${org}:chatwoot-provisioning`,
            row.encrypted_input!,
          ),
        ),
      );
      let stage = row.stage;
      if (stage === "ACCOUNT") {
        await beforeExternal();
        externalPending = true;
        await progress(
          org,
          lease,
          "USER",
          await client.createAccount(input.name, org),
        );
        externalPending = false;
        stage = "USER";
      }
      if (stage === "USER") {
        await beforeExternal();
        externalPending = true;
        await progress(
          org,
          lease,
          "ACCESS",
          undefined,
          await client.createUser({ ...input, organizationId: org }),
        );
        externalPending = false;
        stage = "ACCESS";
      }
      const a = await tx(org, (t) => readChatwootAccount(t, org));
      const current = await read(org);
      if (!a?.account_id || !current?.remote_user_id || !a.encrypted_token)
        throw new IntegrationError("PROVISIONING_STATE_INVALID");
      if (stage === "ACCESS") {
        await beforeExternal();
        externalPending = true;
        await client.addAccountUser(
          Number(a.account_id),
          Number(current.remote_user_id),
          "administrator",
        );
        await progress(org, lease, "VERIFY");
        externalPending = false;
      }
      const tenant = new ChatwootClient({
        baseUrl: env.origin,
        token: env.vault.decrypt(`${org}:chatwoot-account`, a.encrypted_token),
        fetch: options.fetch,
        allowLocal: options.allowLocal,
      });
      await tenant.verifyAccount(Number(a.account_id));
      await progress(org, lease, "DONE");
    } catch (failure) {
      await failed(
        org,
        lease,
        externalPending && !(failure instanceof ChatwootError)
          ? new ChatwootError("PROVISIONING_OUTCOME_UNKNOWN", false, true)
          : failure,
      );
      throw failure;
    }
  }
  return {
    async status(org: string) {
      const row = await read(org);
      return row
        ? { stage: row.stage, state: row.state, lastError: row.last_error }
        : null;
    },
    async start(org: string, value: Input, actorId?: string) {
      platform();
      const input = ProvisionChatwootInput.parse(value);
      await tx(org, async (t) => {
        await requireActiveOrganization(t, org);
        await t.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('chatwoot-account:'||$1,0))",
          [org],
        );
        if (await readChatwootAccount(t, org))
          throw new IntegrationError("CHATWOOT_ACCOUNT_ALREADY_BOUND", 409);
        await t.query(
          "INSERT INTO chatwoot_accounts(organization_id,base_url) VALUES($1,$2)",
          [org, env.origin],
        );
        await t.query(
          "INSERT INTO chatwoot_provisioning(organization_id,encrypted_input) VALUES($1,$2)",
          [
            org,
            env.vault.encrypt(
              `${org}:chatwoot-provisioning`,
              JSON.stringify(input),
            ),
          ],
        );
        await integrationAudit(
          t,
          org,
          "PROVISIONING_STARTED",
          null,
          "Requested dedicated JRC Conversas account",
          actorId,
        );
      });
      const row = await claim(org, false);
      if (row) await execute(org, row);
      return this.status(org);
    },
    async resume(org: string) {
      platform();
      const row = await claim(org, false);
      if (row) await execute(org, row);
      return this.status(org);
    },
    async reconcile(org: string, remoteId?: number) {
      const client = platform(),
        row = await claim(org, true);
      if (!row) return this.status(org);
      const lease = row.lease_token!;
      try {
        if (row.stage === "ACCOUNT") {
          if (!remoteId)
            throw new IntegrationError("PROVISIONING_REMOTE_ID_REQUIRED", 409);
          const remote = await client.platformAccount(remoteId);
          if (remote.custom_attributes.jrc_organization_id !== org)
            throw new IntegrationError("PROVISIONING_ACCOUNT_MISMATCH", 409);
          await progress(org, lease, "USER", remote.id);
        } else if (row.stage === "USER") {
          if (!remoteId)
            throw new IntegrationError("PROVISIONING_REMOTE_ID_REQUIRED", 409);
          const input = ProvisionChatwootInput.parse(
            JSON.parse(
              env.vault.decrypt(
                `${org}:chatwoot-provisioning`,
                row.encrypted_input!,
              ),
            ),
          );
          const remote = await client.platformUser(remoteId);
          if (remote.email.toLowerCase() !== input.email)
            throw new IntegrationError("PROVISIONING_USER_MISMATCH", 409);
          await progress(org, lease, "ACCESS", undefined, {
            id: remote.id,
            token: remote.access_token,
          });
        } else if (row.stage === "ACCESS") {
          const a = await tx(org, (t) => readChatwootAccount(t, org));
          const users = await client.platformAccountUsers(
            Number(a?.account_id),
          );
          if (
            !users.some(
              (u) =>
                u.user_id === Number(row.remote_user_id) &&
                (u.role === "administrator" || u.role === 1),
            )
          )
            throw new IntegrationError(
              "PROVISIONING_ACCESS_NOT_CONFIRMED",
              409,
            );
          await progress(org, lease, "VERIFY");
        }
        await execute(org, (await read(org))!);
      } catch (failure) {
        // Failed inspection does not prove that the earlier creation failed.
        await failed(
          org,
          lease,
          new ChatwootError(
            "PROVISIONING_REQUIRES_RECONCILIATION",
            false,
            true,
          ),
        );
        throw failure;
      }
      return this.status(org);
    },
  };
}
