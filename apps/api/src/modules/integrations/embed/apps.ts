import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { EmbedAppSetupSchema } from '@jrc/contracts';
import type { AuthenticationContext } from '../../../http/plugins/authorization.js';
import type { TenantTransaction } from '../../../db/tenant-transaction.js';
import { resolveChatwootContext, requireApprovedDestination } from '../chatwoot-context.js';
import { requireActiveOrganization } from '../../tenancy/operational-limits.js';
import { EmbedRepository, embedDenied, type EmbedAppRow } from './repository.js';
import { IntegrationError } from '../integration-error.js';
import { ChatwootError, type DashboardAppPayload } from '../chatwoot-client.js';

export function buildDashboardAppUrl(publicOrigin: string, embedId: string): string {
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin || origin.protocol !== 'https:' || origin.username || origin.password) throw new Error('INVALID_EMBED_PUBLIC_ORIGIN');
  return `${publicOrigin}/embed/chatwoot/${z.uuid().parse(embedId)}`;
}
export function buildDashboardAppPayload(title: string, url: string): DashboardAppPayload {
  return { dashboard_app: { title: z.string().trim().min(1).max(100).parse(title), content: [{ type: 'frame', url }] } };
}
type InstallState = 'UNCONFIGURED' | 'INSTALLED' | 'MANUAL' | 'UNKNOWN';
interface InstallRow extends EmbedAppRow { install_state: InstallState; remote_app_id: string | null; install_lease: string | null; leased: boolean }

export class EmbedApps {
  constructor(readonly repository: EmbedRepository) {}
  async current(tx: TenantTransaction, app: EmbedAppRow) {
    this.repository.enabled();
    await requireActiveOrganization(tx, app.organization_id);
    const options = this.repository.options;
    const context = await resolveChatwootContext(tx, app.organization_id, options.managedOrigin);
    const destination = requireApprovedDestination(context.destination, app.organization_id, options.managedOrigin);
    const account = context.account;
    if (!app.active || !account || account.status !== 'READY' || !account.encrypted_token ||
      Number(account.account_id) !== Number(app.account_id) || destination.revision !== app.destination_revision || account.base_url !== destination.baseUrl) throw embedDenied();
    return { account, origin: destination.baseUrl };
  }
  async register(auth: AuthenticationContext) {
    this.repository.enabled();
    if (auth.kind !== 'JWT') throw embedDenied();
    const options = this.repository.options;
    const p = await options.control.authorize(auth, 'chatwoot:manage');
    return options.transact(auth.organizationId, async tx => {
      await options.control.revalidate(tx, p, 'chatwoot:manage');
      const app = (await tx.query<EmbedAppRow>(`INSERT INTO chatwoot_embed_apps(organization_id,account_id,destination_revision) VALUES($1,$2,$3)
        ON CONFLICT(organization_id,destination_revision) DO UPDATE SET account_id=chatwoot_embed_apps.account_id RETURNING *`,
      [p.organizationId, p.accountId, p.destinationRevision])).rows[0]!;
      await this.current(tx, app);
      await options.control.audit(tx, p, 'EMBED_APP_REGISTERED', app.id);
      return { embedId: app.id };
    });
  }
  async policy(embedId: string) {
    const id = z.uuid().parse(embedId), org = await this.repository.resolve('app', id);
    return this.repository.options.transact(org, async tx => {
      const current = await this.current(tx, await this.repository.app(tx, id));
      return { origin: current.origin };
    });
  }
  private setup(row: InstallRow) {
    const origin = this.repository.options.publicOrigin;
    if (!origin) throw new IntegrationError('EMBED_PUBLIC_ORIGIN_REQUIRED', 503);
    return EmbedAppSetupSchema.parse({ embedId: row.id, title: 'Conexões JRC', url: buildDashboardAppUrl(origin, row.id),
      state: row.install_state, remoteAppId: row.remote_app_id === null ? null : Number(row.remote_app_id) });
  }
  private async admin(auth: AuthenticationContext) {
    this.repository.enabled(); if (auth.kind !== 'JWT') throw embedDenied();
    return this.repository.options.control.authorize(auth, 'chatwoot:manage');
  }
  async describe(auth: AuthenticationContext, embedId: string) {
    const p = await this.admin(auth), options = this.repository.options;
    return options.transact(p.organizationId, async tx => {
      await options.control.revalidate(tx, p, 'chatwoot:manage');
      const row = await this.repository.app(tx, z.uuid().parse(embedId)); await this.current(tx, row);
      return this.setup(row as InstallRow);
    });
  }
  async install(auth: AuthenticationContext, embedId: string) {
    const options = this.repository.options, p = await this.admin(auth), lease = randomUUID();
    if (!options.dashboardClient) throw new IntegrationError('EMBED_INSTALL_UNAVAILABLE', 503);
    const captured = await options.transact(p.organizationId, async tx => {
      await options.control.revalidate(tx, p, 'chatwoot:manage');
      const row = (await tx.query<InstallRow>('SELECT *,install_lease_until>clock_timestamp() AS leased FROM chatwoot_embed_apps WHERE id=$1 FOR UPDATE', [z.uuid().parse(embedId)])).rows[0];
      if (!row) throw embedDenied();
      const current = await this.current(tx, row), setup = this.setup(row);
      if (row.leased) throw new IntegrationError('EMBED_INSTALL_IN_PROGRESS', 409);
      await tx.query("UPDATE chatwoot_embed_apps SET install_lease=$2,install_lease_until=clock_timestamp()+interval '60 seconds' WHERE id=$1", [embedId, lease]);
      return { account: current.account, setup, state: row.install_state };
    });
    let state = captured.state, remoteId: number | null = null;
    const recheck = async (tx: TenantTransaction) => {
      await options.control.revalidate(tx, p, 'chatwoot:manage');
      const row = (await tx.query<InstallRow>('SELECT *,install_lease_until>clock_timestamp() AS leased FROM chatwoot_embed_apps WHERE id=$1 FOR UPDATE', [embedId])).rows[0];
      if (!row || row.install_lease !== lease || !row.leased) throw new IntegrationError('EMBED_INSTALL_CONTEXT_CHANGED', 409);
      const current = await this.current(tx, row);
      if (current.account.credential_version !== captured.account.credential_version) throw new IntegrationError('EMBED_INSTALL_CONTEXT_CHANGED', 409);
    };
    try {
      const client = options.dashboardClient(captured.account);
      await client.verifyAccount(p.accountId);
      await options.transact(p.organizationId, recheck);
      const matches = (await client.listDashboardApps(p.accountId)).filter(app => app.content.length === 1 && app.content[0]?.type === 'frame' && app.content[0].url === captured.setup.url);
      if (matches.length === 1) { state = 'INSTALLED'; remoteId = matches[0]!.id; }
      else if (matches.length > 1 || state === 'UNKNOWN') state = 'UNKNOWN';
      else {
        // Commit uncertainty BEFORE dispatch: restart/retry cannot repeat a possibly completed POST.
        await options.transact(p.organizationId, async tx => { await recheck(tx); await tx.query("UPDATE chatwoot_embed_apps SET install_state='UNKNOWN',remote_app_id=NULL WHERE id=$1", [embedId]); });
        state = 'UNKNOWN';
        const created = await client.createDashboardApp(p.accountId, buildDashboardAppPayload(captured.setup.title, captured.setup.url));
        if (created.content.length === 1 && created.content[0]?.type === 'frame' && created.content[0].url === captured.setup.url) { state = 'INSTALLED'; remoteId = created.id; }
      }
    } catch (error) {
      if (error instanceof ChatwootError && [403, 404].includes(error.httpStatus ?? 0)) state = captured.state === 'UNKNOWN' ? 'UNKNOWN' : 'MANUAL';
      else if (state !== 'UNKNOWN' || error instanceof IntegrationError) {
        await options.transact(p.organizationId, tx => tx.query('UPDATE chatwoot_embed_apps SET install_lease=NULL,install_lease_until=NULL WHERE id=$1 AND install_lease=$2', [embedId, lease]));
        throw error;
      }
    }
    return options.transact(p.organizationId, async tx => {
      await recheck(tx);
      const row = (await tx.query<InstallRow>('UPDATE chatwoot_embed_apps SET install_state=$3,remote_app_id=$4,install_lease=NULL,install_lease_until=NULL WHERE id=$1 AND install_lease=$2 RETURNING *', [embedId, lease, state, remoteId])).rows[0]!;
      await options.control.audit(tx, p, `EMBED_INSTALL_${state}`, embedId);
      return this.setup(row);
    });
  }
}
