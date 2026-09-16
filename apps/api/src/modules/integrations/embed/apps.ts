import { z } from 'zod';
import type { AuthenticationContext } from '../../../http/plugins/authorization.js';
import type { TenantTransaction } from '../../../db/tenant-transaction.js';
import { resolveChatwootContext, requireApprovedDestination } from '../chatwoot-context.js';
import { requireActiveOrganization } from '../../tenancy/operational-limits.js';
import { EmbedRepository, embedDenied, type EmbedAppRow } from './repository.js';

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
}
