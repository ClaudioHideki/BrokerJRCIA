import {createHash} from 'node:crypto';
import {z} from 'zod';

const revision=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const scopeSchema=z.strictObject({
 organizationId:z.uuid(),channelId:z.uuid(),integrationId:z.uuid(),destinationRevision:revision,
 instanceId:z.uuid(),identityRevision:revision,identityFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),
 groupJid:z.string().max(128).regex(/^\d+(?:-\d+)?@g\.us$/u),
});
export type GroupCentralScope=z.infer<typeof scopeSchema>;

/** A remote display envelope only. It is never a local person or routing authority. */
export function groupCentralEnvelope(input:GroupCentralScope,subject:string){
 const scope=scopeSchema.parse(input);
 const name=z.string().trim().min(1).max(256).parse(subject);
 const scopeKey=createHash('sha256').update(JSON.stringify([
  'jrc-group-central-v1',scope.organizationId,scope.channelId,scope.integrationId,
  scope.destinationRevision,scope.instanceId,scope.identityRevision,scope.identityFingerprint,scope.groupJid,
 ])).digest('hex');
 return {scopeKey,contact:{name:`Grupo · ${name}`,identifier:`jrc-group-${scopeKey}`,
  additional_attributes:{jrc_broker_recipient_kind:'GROUP' as const,jrc_broker_group_scope:scopeKey}},
  sourceId:`jrc-group-${scopeKey}`};
}

const textSchema=z.string().min(1).max(4096);
const participantSchema=z.string().max(128).regex(/^\d+(?::\d+)?@(?:s\.whatsapp\.net|lid)$/u);
/** Caller supplies facts from the authenticated QR ingress, never browser metadata. */
export function groupMessagePresentation(input:{text:string;participantJid:string|null;fromMe:boolean}){
 const text=textSchema.parse(input.text),fromMe=z.boolean().parse(input.fromMe);
 const participant=input.participantJid===null?null:participantSchema.parse(input.participantJid).replace(/:\d+(?=@)/u,'');
 if(!fromMe&&!participant)throw Error('GROUP_PARTICIPANT_REQUIRED');
 const header=fromMe?'[Saída observada no WhatsApp]':`[Participante: ${participant}]`;
 return {text:`${header}\n${text}`,attributes:{
  jrc_broker_recipient_kind:'GROUP' as const,
  jrc_broker_participant_jid:participant,
  jrc_broker_message_origin:fromMe?'EXTERNAL_OBSERVED' as const:'GROUP_PARTICIPANT' as const,
 }};
}
