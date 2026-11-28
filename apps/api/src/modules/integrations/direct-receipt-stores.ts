import { createHash } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import { z } from 'zod';
import { railsAttributes,railsDeleted } from './direct-source-policy.js';
import { proofSchema } from './direct-receipt-contract.js';

const custodySchema=z.strictObject({organizationId:z.uuid(),integrationId:z.uuid(),channelId:z.uuid(),origin:z.url(),
  accountId:z.number().int().positive(),inboxId:z.number().int().positive(),instanceId:z.string().min(1),
  generation:z.string().min(1),brokerInstanceId:z.string().min(1),validFrom:z.iso.datetime(),validUntil:z.iso.datetime()});
const digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
function check(value:unknown):asserts value {if(!value)throw new Error('DIRECT_STORES_DISAGREE');}
async function readOnly<T>(pool:Pool,work:(client:PoolClient)=>Promise<T>){
  const client=await pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='12s'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    return await work(client);
  }finally{try{await client.query('ROLLBACK');}finally{client.release();}}
}

export async function verifyDirectStores(raw:Buffer,custody:Buffer,expectedHash:string,rails:Pool,evolution:Pool){
  check(raw.length<=16384 && custody.length<=4096 && digest(custody)===expectedHash);
  const p=proofSchema.parse(JSON.parse(raw.toString('utf8'))),s=custodySchema.parse(JSON.parse(custody.toString('utf8')));
  const r=p.rails,e=p.evolution,a=p.ack;
  check(p.historicalBinding.evidenceSha256===expectedHash && p.origin===s.origin && p.organizationId===s.organizationId &&
    p.integrationId===s.integrationId && p.channelId===s.channelId && r.accountId===s.accountId && r.inboxId===s.inboxId &&
    p.historicalBinding.instanceId===s.instanceId && p.historicalBinding.generation===s.generation && s.instanceId===e.instanceId &&
    a.instanceId===e.instanceId && r.sourceId==='WAID:'+e.key && a.key===e.key && a.peer===e.peer && a.remoteJid===e.remoteJid && a.messageRowId===e.rowId &&
    r.accountId===e.accountId && r.inboxId===e.inboxId && r.conversationId===e.conversationId && r.messageId===e.messageId);
  const period=[s.validFrom,s.validUntil];
  await Promise.all([
    readOnly(rails,async client=>{
      const rows=await client.query(`SELECT m.content,m.content_attributes::jsonb attrs,m.additional_attributes::jsonb extra
        FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.account_id=m.account_id AND c.inbox_id=m.inbox_id
        JOIN contacts ct ON ct.id=c.contact_id AND ct.account_id=c.account_id
        JOIN contact_inboxes ci ON ci.id=c.contact_inbox_id AND ci.contact_id=ct.id AND ci.inbox_id=c.inbox_id
        JOIN jrc_broker_webhook_obligations o ON o.message_id=m.id AND o.account_id=m.account_id AND o.inbox_id=m.inbox_id
        JOIN jrc_broker_inbox_bindings b ON b.id=o.binding_id AND b.account_id=o.account_id AND b.inbox_id=o.inbox_id
          AND b.integration_id::text=o.integration_id AND b.instance_id::text=o.instance_id
        JOIN inboxes i ON i.id=m.inbox_id AND i.account_id=m.account_id AND i.channel_type='Channel::Api'
        JOIN channel_api ch ON ch.id=i.channel_id AND ch.webhook_url=o.url AND length(ch.webhook_url)>0
        WHERE o.state='delivered' AND m.id=$1 AND m.account_id=$2 AND m.inbox_id=$3 AND c.display_id=$4 AND o.delivery_id=$5
          AND o.integration_id=$6 AND o.instance_id=$7 AND m.source_id=$8 AND o.created_at >= $9::timestamptz AND o.created_at < $10::timestamptz
          AND regexp_replace(ct.phone_number,'^[+]','')=$11
          AND m.message_type=1 AND m.private=false AND m.sender_type='User' AND m.sender_id>0
          AND NOT EXISTS(SELECT 1 FROM attachments WHERE message_id=m.id)`,
        [r.messageId,r.accountId,r.inboxId,r.conversationId,r.obligationId,p.integrationId,s.brokerInstanceId,r.sourceId,...period,e.peer.split('@')[0]]);
      check(rows.rowCount===1);
      const row=rows.rows[0],attrs=railsAttributes.parse(row.attrs),extra=railsAttributes.parse(row.extra);
      for(const obj of [attrs,extra]){
        check(!railsDeleted(obj));
        check([undefined,false,'false'].includes(obj.jrc_broker_historical as undefined|boolean|string));
      }
      check(!['jrc_broker_message_id','external_echo','automation_rule_id'].some(k=>Object.hasOwn(attrs,k)) &&
        !['campaign_id','jrc_campaign_broker','jrc_campaign_evolution'].some(k=>Object.hasOwn(extra,k)));
      const outbound=attrs.jrc_broker_outbound===undefined?{}:z.record(z.string(),z.unknown()).parse(attrs.jrc_broker_outbound);
      check(outbound.canonical_message_id==null && outbound.provider_message_id==null && (outbound.intent_id??null)===r.intentId &&
        typeof row.content==='string' && digest(row.content)===r.bodySha256);
    }),
    readOnly(evolution,async client=>{
      const rows=await client.query(`WITH candidates AS MATERIALIZED(
          SELECT m.* FROM "Message" m WHERE m."instanceId"=$1 AND (m."chatwootMessageId"=$2 OR m.key->>'id'=$3)
        ) SELECT coalesce(m.message->>'conversation',m.message->'extendedTextMessage'->>'text') body
        FROM candidates m JOIN "MessageUpdate" u ON u."messageId"=m.id AND u."instanceId"=m."instanceId"
        JOIN "Chatwoot" config ON config."instanceId"=m."instanceId" AND config."accountId"=$7 AND rtrim(config.url,'/')=$8
        WHERE (SELECT count(*) FROM candidates)=1 AND m.id=$4 AND m."chatwootMessageId"=$2 AND m."chatwootInboxId"=$5
          AND m."chatwootConversationId"=$6 AND m.key->>'id'=$3 AND m.key->>'remoteJid'=$14 AND m.key->'fromMe'='true'::jsonb
          AND u.id=$10 AND u."keyId"=$3 AND u."remoteJid"=$14 AND u."fromMe"=true AND u.status=$11
          AND to_timestamp(m."messageTimestamp") >= $12::timestamptz AND to_timestamp(m."messageTimestamp") < $13::timestamptz
          AND ($14=$9 OR (m.key->>'remoteJidAlt'=$9 AND NOT EXISTS(
            SELECT 1 FROM "Message" history
            WHERE history."instanceId"=m."instanceId" AND history."messageTimestamp">=extract(epoch FROM $12::timestamptz)
              AND history."messageTimestamp"<extract(epoch FROM $13::timestamptz)
              AND nullif(history.key->>'remoteJidAlt','') IS NOT NULL AND nullif(history.key->>'remoteJid','') IS NOT NULL AND (
                (history.key->>'remoteJid'=$14 AND history.key->>'remoteJidAlt'<>$9) OR
                (history.key->>'remoteJidAlt'=$14 AND history.key->>'remoteJid'<>$9) OR
                (history.key->>'remoteJid'=$9 AND history.key->>'remoteJidAlt'<>$14) OR
                (history.key->>'remoteJidAlt'=$9 AND history.key->>'remoteJid'<>$14)
              ))))
          AND ((m.message ? 'conversation') <> (m.message ? 'extendedTextMessage'))
          AND (m.message - ARRAY['conversation','extendedTextMessage','messageContextInfo'])='{}'::jsonb`,
        [e.instanceId,r.messageId,e.key,e.rowId,r.inboxId,r.conversationId,String(r.accountId),p.origin,e.peer,a.rowId,a.status,...period,e.remoteJid??e.peer]);
      check(rows.rowCount===1 && typeof rows.rows[0].body==='string' && digest(rows.rows[0].body)===e.bodySha256 && e.bodySha256===r.bodySha256);
    })
  ]);
  return true;
}
