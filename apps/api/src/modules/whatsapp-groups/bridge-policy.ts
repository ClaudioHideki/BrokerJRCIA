import {z} from 'zod';
import {groupMessagePresentation} from './group-central-identity.js';
const reply=z.object({attendanceObservationId:z.uuid(),attendanceKind:z.literal('HUMAN_PUBLIC'),destinationRevision:z.number().int().positive(),messageId:z.number().int().positive(),conversationId:z.number().int().positive(),content:z.strictObject({type:z.literal('TEXT'),text:z.string().min(1).max(4096)}),attachments:z.never().optional()});
export const requireGroupReply=(input:unknown)=>reply.parse(input);
export function groupMirrorText(input:{direction:string;source:string;text:string;participant:string|null}){
 if(input.direction==='INCOMING'||input.source==='EXTERNAL_OBSERVED')return groupMessagePresentation({text:input.text,participantJid:input.participant,fromMe:input.source==='EXTERNAL_OBSERVED'}).text;
 return z.string().min(1).max(4096).parse(input.text);
}
