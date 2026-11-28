import type {TenantTransaction} from '../../db/tenant-transaction.js';

/** Opt-in applies to the organization and channel resolved by the authenticated transport. */
export function inboundNoticesEnabled(org:string,channel:string) {
  return (process.env.QR_INBOUND_NOTICE_SCOPES ?? '').split(',').some(entry=>entry.trim() === org+'/'+channel);
}

export const contactCardArrival = 'Cartão de contato recebido pelo WhatsApp. O conteúdo do cartão está indisponível no Atendimento.';

export async function readTerminalInboundMedia(tx:TenantTransaction,org:string,jobId:string){
  if(!process.env.QR_INBOUND_NOTICE_SCOPES?.trim())return;
  const row=(await tx.query<{channel_id:string;reason:string;possible_effect:boolean}>(`
    SELECT m.channel_id,a.last_error AS reason,
      (j.payload ?| ARRAY['operation','liveIngressProof','remoteMessageId'] OR
       EXISTS(SELECT 1 FROM chatwoot_messages cm WHERE cm.organization_id=j.organization_id AND cm.message_id=m.id) OR
       EXISTS(SELECT 1 FROM chatwoot_mirror_attempts prev WHERE prev.organization_id=j.organization_id AND prev.message_id=m.id) OR
       EXISTS(SELECT 1 FROM integration_jobs sibling WHERE sibling.organization_id=j.organization_id AND sibling.message_id=m.id
         AND sibling.kind='MIRROR_MESSAGE' AND sibling.id<>j.id AND sibling.payload ?| ARRAY['operation','liveIngressProof','remoteMessageId'])) AS possible_effect
    FROM integration_jobs j JOIN messaging_messages m ON m.organization_id=j.organization_id AND m.id=j.message_id
    JOIN chatwoot_connections route ON route.organization_id=j.organization_id AND route.id=j.integration_id AND route.channel_id=m.channel_id
    JOIN messaging_conversations cv ON cv.organization_id=m.organization_id AND cv.channel_id=m.channel_id AND cv.id=m.conversation_id
    JOIN messaging_media a ON a.organization_id=m.organization_id AND a.channel_id=m.channel_id AND a.id=m.media_id
    WHERE j.organization_id=$1 AND j.id=$2 AND j.kind='MIRROR_MESSAGE' AND cv.recipient_kind='INDIVIDUAL'
      AND m.direction='INCOMING' AND m.source='CONTACT' AND NOT m.is_historical AND m.content->>'type'='MEDIA'
      AND a.source='QR' AND a.source_key=m.upstream_message_id AND a.descriptor->>'messageId'=m.upstream_message_id
      AND a.status='FAILED' AND (a.last_error IN ('MEDIA_SIZE_LIMIT','MEDIA_TYPE_UNSUPPORTED','MEDIA_REFERENCE_EXPIRED','MEDIA_RESPONSE_SIZE_LIMIT') OR
          (a.last_error IN ('MEDIA_DOWNLOAD_FAILED','MEDIA_LENGTH_MISMATCH','MEDIA_DOWNLOAD_UNAVAILABLE',
            'MEDIA_RESPONSE_INVALID','MEDIA_DOWNLOAD_INTERRUPTED','MEDIA_SOURCE_NOT_FOUND') AND a.attempts>=6))
    FOR SHARE OF a`,[org,jobId])).rows[0];
  if(row && inboundNoticesEnabled(org,row.channel_id))return row;
}

export function unavailableMediaText(reason:unknown):string|undefined {
  switch(reason){
    case 'MEDIA_SIZE_LIMIT': return 'Anexo recebido pelo WhatsApp. O arquivo está indisponível no Atendimento porque excede o limite de tamanho.';
    case 'MEDIA_TYPE_UNSUPPORTED': return 'Anexo recebido pelo WhatsApp. O arquivo está indisponível no Atendimento porque o formato não é aceito.';
    case 'MEDIA_REFERENCE_EXPIRED': return 'Anexo recebido pelo WhatsApp. O arquivo está indisponível no Atendimento porque a origem informou que a referência expirou.';
    case 'MEDIA_RESPONSE_SIZE_LIMIT': return 'Anexo recebido pelo WhatsApp. O arquivo está indisponível no Atendimento porque a resposta da origem excedeu o limite de leitura.';
    case 'MEDIA_DOWNLOAD_UNAVAILABLE': return 'Anexo recebido pelo WhatsApp. O arquivo está indisponível no Atendimento porque a origem permaneceu indisponível durante as tentativas de download.';
    case 'MEDIA_RESPONSE_INVALID': return 'Anexo recebido pelo WhatsApp. O arquivo está indisponível no Atendimento porque a origem não retornou uma mídia válida.';
    case 'MEDIA_DOWNLOAD_INTERRUPTED': return 'Anexo recebido pelo WhatsApp. O arquivo está indisponível no Atendimento porque a leitura foi interrompida.';
    case 'MEDIA_SOURCE_NOT_FOUND': return 'Anexo recebido pelo WhatsApp. O arquivo está indisponível no Atendimento porque a origem não localizou o recurso solicitado.';
    case 'MEDIA_DOWNLOAD_FAILED': return 'Anexo recebido pelo WhatsApp. O arquivo está indisponível no Atendimento após o encerramento das tentativas de download.';
    case 'MEDIA_LENGTH_MISMATCH': return 'Anexo recebido pelo WhatsApp. O arquivo está indisponível no Atendimento porque o tamanho baixado diverge do declarado.';
    default: return undefined;
  }
}
