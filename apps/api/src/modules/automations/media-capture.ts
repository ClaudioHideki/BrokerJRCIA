import {AutomationInputMediaSchema,type AutomationInputMedia} from '@jrc/contracts';
import {z} from 'zod';
import type {TenantTransaction} from '../../db/tenant-transaction.js';
import {AutomationError} from './errors.js';
import {readCentralTransportBinding} from '../messaging/central-transport.js';

/** Only the message's existing tenant/channel/conversation binding grants this reference. No transport is called. */
export async function readCanonicalInputMedia(tx:TenantTransaction,org:string,channelId:string,conversationId:string|null,messageId:string):Promise<AutomationInputMedia>{
 if(!conversationId||!z.uuid().safeParse(messageId).success)throw new AutomationError('AUTOMATION_INPUT_MEDIA_NOT_FOUND',404);
 const row=(await tx.query(`SELECT message.id AS "messageId",asset.id AS "mediaId",asset.kind,asset.file_name AS "fileName"
  FROM messaging_messages message JOIN messaging_media asset
    ON asset.organization_id=message.organization_id AND asset.channel_id=message.channel_id AND asset.id=message.media_id
  WHERE message.organization_id=$1 AND message.channel_id=$2 AND message.conversation_id=$3 AND message.id=$4
    AND message.direction='INCOMING' AND message.source='CONTACT' AND message.content->>'type'='MEDIA'`,[org,channelId,conversationId,messageId])).rows[0];
 const parsed=AutomationInputMediaSchema.safeParse(row?{source:'CANONICAL_MESSAGE',...row}:undefined);
 if(!parsed.success)throw new AutomationError('AUTOMATION_INPUT_MEDIA_NOT_FOUND',404);
 return parsed.data;
}

/** These rows are not messaging_media assets and cannot be downloaded by media workers. */
export async function readCanonicalCentralInputMedia(tx:TenantTransaction,org:string,channelId:string,conversationId:string|null,raw:unknown):Promise<AutomationInputMedia>{
 const identity=z.strictObject({type:z.literal('MEDIA'),referenceId:z.uuid()}).safeParse(raw);
 if(!conversationId||!identity.success)throw new AutomationError('AUTOMATION_INPUT_MEDIA_NOT_FOUND',404);
 const row=(await tx.query<{id:string;integration_id:string;origin:string;account_id:string;inbox_id:string;destination_revision:number;credential_version:number;owner_revision:number;kind:string;file_name:string}>(`
  SELECT r.* FROM central_flow_input_media r JOIN central_runtime_events e ON e.organization_id=r.organization_id AND e.id=r.event_id
  WHERE r.organization_id=$1 AND r.channel_id=$2 AND r.conversation_id=$3 AND r.id=$4
   AND e.kind='CONTACT_MEDIA' AND e.media_input->>'version'='1' AND e.channel_id=r.channel_id
   AND e.conversation_id=r.conversation_id AND e.integration_id=r.integration_id AND e.disposition IN ('RECEIVED','ROUTED')`,[org,channelId,conversationId,identity.data.referenceId])).rows[0];
 if(!row)throw new AutomationError('AUTOMATION_INPUT_MEDIA_NOT_FOUND',404);
 const {binding}=await readCentralTransportBinding(tx,org,row.integration_id,true);
 if(binding.channelId!==channelId||binding.origin!==row.origin||binding.accountId!==Number(row.account_id)||binding.inboxId!==Number(row.inbox_id)||
  binding.destinationRevision!==row.destination_revision||binding.credentialVersion!==row.credential_version||binding.ownerRevision!==row.owner_revision)
  throw new AutomationError('AUTOMATION_INPUT_MEDIA_CONTEXT_CHANGED',409);
 return AutomationInputMediaSchema.parse({source:'CENTRAL_ATTACHMENT_REFERENCE',referenceId:row.id,kind:row.kind,fileName:row.file_name});
}
