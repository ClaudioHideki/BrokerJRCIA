import { LocalConversationContextSchema, type LocalConversationContext } from '@jrc/contracts';
import type { TenantTransaction } from '../../db/tenant-transaction.js';

/** A single read snapshot, under the existing tenant transaction. Internal notes
 * are facts of standalone automation, never transport messages or delivery ACKs. */
export async function readLocalConversationContext(tx: TenantTransaction, organizationId: string,
  channelId: string, conversationId: string): Promise<LocalConversationContext | undefined> {
  const row = (await tx.query<{
    revision: string; status: 'OPEN' | 'RESOLVED'; labels: LocalConversationContext['labels'];
    attributes: LocalConversationContext['attributes']; privateNotes: LocalConversationContext['privateNotes'];
  }>(`SELECT s.revision::text AS revision,s.status,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name) ORDER BY a.name,a.id)
      FROM automation_action_resources a WHERE a.organization_id=s.organization_id AND a.channel_id=s.channel_id
      AND a.source='LOCAL' AND a.kind='LABEL' AND s.labels ? a.id::text),'[]'::jsonb) AS labels,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('key',v.key,'name',COALESCE(a.name,v.key),'value',v.value) ORDER BY v.key)
      FROM jsonb_each(s.attributes) v LEFT JOIN automation_action_resources a ON a.organization_id=s.organization_id
      AND a.channel_id=s.channel_id AND a.source='LOCAL' AND a.kind='ATTRIBUTE' AND a.key=v.key),'[]'::jsonb) AS attributes,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',n.id,'text',n.body,
      'createdAt',to_char(n.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY n.created_at DESC,n.id DESC)
      FROM (SELECT id,body,created_at FROM automation_private_notes WHERE organization_id=s.organization_id
        AND channel_id=s.channel_id AND conversation_id=s.conversation_id ORDER BY created_at DESC,id DESC LIMIT 101) n),'[]'::jsonb) AS "privateNotes"
    FROM automation_conversation_state s JOIN messaging_conversations c ON c.organization_id=s.organization_id
      AND c.channel_id=s.channel_id AND c.id=s.conversation_id
    WHERE s.organization_id=$1 AND s.channel_id=$2 AND s.conversation_id=$3
      AND NOT EXISTS(SELECT 1 FROM chatwoot_connections x WHERE x.organization_id=s.organization_id AND x.channel_id=s.channel_id)`,
  [organizationId, channelId, conversationId])).rows[0];
  if (!row) return undefined;
  return LocalConversationContextSchema.parse({ ...row, scope: { organizationId, channelId, conversationId },
    privateNotes: row.privateNotes.slice(0, 100), notesTruncated: row.privateNotes.length > 100 });
}
