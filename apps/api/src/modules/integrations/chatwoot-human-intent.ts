import { z } from 'zod';
import { IntegrationError } from './integration-error.js';
import { CHATWOOT_WEBHOOK_WINDOW_MS } from './secrets.js';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const intentSchema = z.object({version:z.literal(1),state:z.literal('PENDING'),intent_id:z.uuid(),integration_id:z.uuid(),inbox_id:z.number().int().positive()});
const historical = (attributes: Record<string, unknown>) => attributes.jrc_broker_historical === true || attributes.jrc_broker_historical === 'true';

/** A hint from an authenticated callback, never dispatch authority by itself. */
export function humanOutboundIntent(attributes: unknown, scope: {integrationId:string;inboxId:number}): string | undefined {
  const content=record(attributes),parsed=intentSchema.safeParse(content.jrc_broker_outbound);
  if(!parsed.success||content.jrc_broker_message_id!=null||historical(content)||
    parsed.data.integration_id!==scope.integrationId||parsed.data.inbox_id!==scope.inboxId)return undefined;
  return parsed.data.intent_id;
}

/** Re-read the exact persisted remote message before the local idempotent enqueue. */
export function requireCanonicalHumanIntent(raw:unknown,expected:{intentId:string;integrationId:string;accountId:number;inboxId:number;
  conversationId:number;messageId:number;senderId:number;admittedAt?:Date;content?:{type:'TEXT';text:string};caption?:string;
  attachments?:{id:number;kind:'image'|'audio'|'video'|'document'}[]}):void {
  const message=record(raw),attributes=record(message.content_attributes),additional=record(message.additional_attributes),sender=record(message.sender);
  const fail=()=>{throw new IntegrationError('CHATWOOT_HUMAN_INTENT_NOT_PROVEN',409);};
  // A first delivery of an old signed webhook must not gain new-cycle authority.
  // Compare the persisted admission time so a delayed worker may still finish.
  if(expected.admittedAt && (typeof message.created_at!=='number'||
    Math.abs(expected.admittedAt.getTime()-message.created_at*1000)>CHATWOOT_WEBHOOK_WINDOW_MS))
    throw new IntegrationError('CHATWOOT_CYCLE_HISTORICAL_INTENT_REVIEW',409);
  if(message.id!==expected.messageId||message.conversation_id!==expected.conversationId||message.inbox_id!==expected.inboxId||
    message.account_id!==undefined&&message.account_id!==expected.accountId||message.private!==false||
    ![1,'outgoing'].includes(message.message_type as number|string)||sender.type!=='user'||sender.id!==expected.senderId||
    historical(additional)||additional.campaign_id!=null||attributes.automation_rule_id!=null||
    humanOutboundIntent(attributes,expected)!==expected.intentId)fail();
  const attachments=Array.isArray(message.attachments)?message.attachments:[];
  if(expected.content){if(message.content!==expected.content.text||attachments.length)fail();return;}
  if(!expected.attachments||attachments.length!==expected.attachments.length||(message.content??'')!==(expected.caption??''))fail();
  const actual=attachments.map(value=>{const attachment=record(value);return {id:attachment.id,kind:attachment.file_type==='file'?'document':attachment.file_type};});
  if(new Set(actual.map(value=>value.id)).size!==actual.length||expected.attachments!.some(want=>!actual.some(got=>got.id===want.id&&got.kind===want.kind)))fail();
}
