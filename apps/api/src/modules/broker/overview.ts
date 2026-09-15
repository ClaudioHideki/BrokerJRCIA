import { BrokerOverviewSchema, type BrokerOverview } from '@jrc/contracts';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
interface Snapshot {
  connections: { provider: 'BAILEYS' | 'META'; status: string; count: number }[];
  daily: BrokerOverview['daily'];
  incidents: BrokerOverview['incidents'];
}
export function buildBrokerOverview(snapshot: Snapshot, days: number, now: Date): BrokerOverview {
  const connections = {
    total: 0,
    online: 0,
    attention: 0,
    disconnected: 0,
    provisioning: 0,
    unobserved: 0,
  };
  const providers: BrokerOverview['providers'] = [
    { provider: 'BAILEYS', total: 0, online: 0 },
    { provider: 'META', total: 0, online: 0 },
  ];
  for (const row of snapshot.connections) {
    connections.total += row.count;
    const provider = providers.find((p) => p.provider === row.provider)!;
    provider.total += row.count;
    if (['CONNECTED', 'READY'].includes(row.status)) {
      connections.online += row.count;
      provider.online += row.count;
    } else if (['ERROR', 'PROVISIONING_FAILED', 'AWAITING_ACTION'].includes(row.status))
      connections.attention += row.count;
    else if (['DISCONNECTED', 'DISCONNECTING', 'REVOKED'].includes(row.status))
      connections.disconnected += row.count;
    else if (['CREATED', 'PROVISIONING', 'CONNECTING', 'PENDING'].includes(row.status))
      connections.provisioning += row.count;
    else connections.unobserved += row.count;
  }
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - days + 1);
  const daily: BrokerOverview['daily'] = Array.from({ length: days }, (_, i) => {
    const date = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    return (
      snapshot.daily.find((d) => d.date === date) ?? {
        date,
        incoming: 0,
        outgoing: 0,
        delivered: 0,
        failed: 0,
        unknown: 0,
      }
    );
  });
  const messages = daily.reduce(
    (sum, d) => ({
      incoming: sum.incoming + d.incoming,
      outgoing: sum.outgoing + d.outgoing,
      delivered: sum.delivered + d.delivered,
      failed: sum.failed + d.failed,
      unknown: sum.unknown + d.unknown,
    }),
    { incoming: 0, outgoing: 0, delivered: 0, failed: 0, unknown: 0 },
  );
  return BrokerOverviewSchema.parse({
    observedAt: now.toISOString(),
    periodDays: days,
    periodStart: start.toISOString(),
    timezone: 'UTC',
    connections,
    providers,
    messages,
    daily,
    incidents: snapshot.incidents.map((incident) => ({
      ...incident,
      updatedAt: new Date(incident.updatedAt).toISOString(),
    })),
    billing: null,
  });
}
export async function readBrokerOverview(
  tx: TenantTransaction,
  organizationId: string,
  days: number,
) {
  // One statement gives every chart the same database snapshot. Only public aggregate data is selected.
  const result = await tx.query<{ snapshot: Snapshot; observedAt: Date }>(
    `
 WITH channel_states AS (
   SELECT pa.provider::text AS provider,i.status::text AS status FROM instances i
   JOIN provider_accounts pa ON pa.organization_id=i.organization_id AND pa.id=i.provider_account_id
   WHERE i.organization_id=$1 AND pa.provider='BAILEYS'
   UNION ALL
   SELECT 'META',COALESCE(mc.status,'UNOBSERVED') FROM messaging_channels c
   LEFT JOIN meta_connections mc ON mc.organization_id=c.organization_id AND mc.channel_id=c.id
   WHERE c.organization_id=$1
 ), connection_counts AS (
   SELECT provider,status,count(*)::int AS count FROM channel_states GROUP BY provider,status
 ), daily AS (
   SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS date,
   count(*) FILTER(WHERE direction='INCOMING')::int AS incoming,
   count(*) FILTER(WHERE direction='OUTGOING')::int AS outgoing,
   count(*) FILTER(WHERE direction='OUTGOING' AND state IN ('DELIVERED','READ'))::int AS delivered,
   count(*) FILTER(WHERE direction='OUTGOING' AND state='FAILED')::int AS failed,
   count(*) FILTER(WHERE direction='OUTGOING' AND state='UNKNOWN')::int AS unknown
   FROM messaging_messages WHERE organization_id=$1
   AND created_at >= (date_trunc('day',statement_timestamp() AT TIME ZONE 'UTC')-($2::int-1)*interval '1 day') AT TIME ZONE 'UTC'
   AND created_at <= statement_timestamp() GROUP BY 1
 ), incidents AS (
   SELECT op.id,op.instance_id AS "instanceId",i.name,op.status,op.updated_at AS "updatedAt"
   FROM provider_operations op JOIN instances i ON i.organization_id=op.organization_id AND i.id=op.instance_id
   WHERE op.organization_id=$1 AND op.status IN ('FAILED','UNKNOWN')
   AND op.updated_at >= (date_trunc('day',statement_timestamp() AT TIME ZONE 'UTC')-($2::int-1)*interval '1 day') AT TIME ZONE 'UTC'
   ORDER BY op.updated_at DESC,op.id DESC LIMIT 10
 )
 SELECT statement_timestamp() AS "observedAt",jsonb_build_object(
 'connections',COALESCE((SELECT jsonb_agg(c) FROM connection_counts c),'[]'::jsonb),
 'daily',COALESCE((SELECT jsonb_agg(d) FROM daily d),'[]'::jsonb),
 'incidents',COALESCE((SELECT jsonb_agg(i) FROM incidents i),'[]'::jsonb)) AS snapshot`,
    [organizationId, days],
  );
  const row = result.rows[0];
  if (!row) throw new Error('OVERVIEW_UNAVAILABLE');
  return buildBrokerOverview(row.snapshot, days, row.observedAt);
}
