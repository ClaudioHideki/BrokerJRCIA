import { z } from 'zod';

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const groupJid = z.string().max(128).regex(/^\d+(?:-\d+)?@g\.us$/u);
const participantJid = z.string().max(128).regex(/^(?:[1-9]\d{6,14}(?::\d+)?@s\.whatsapp\.net|\d+(?::\d+)?@lid)$/u)
  .transform(value => value.replace(/:\d+(?=@)/u, ''));
const action = z.enum(['add', 'remove', 'promote', 'demote']);
export interface QrGroupEvent {
  kind: 'group'; action: 'UPSERT' | 'UPDATE' | 'ADD' | 'REMOVE' | 'PROMOTE' | 'DEMOTE';
  groupJid: string; providerEmittedAt: string; senderJid: string; authorJid: string | null;
  participants: string[]; metadata: { subject?: string; ownerJid?: string; subjectAuthorJid?: string;
    announce?: boolean; restrict?: boolean; isCommunity?: boolean; isCommunityAnnounce?: boolean; linkedParent?: string | null };
}

/** Called only after QR webhook authentication and stored instance resolution.
 * The upstream date_time is a declared provider wall clock, not a causal clock.
 * participantsData.phoneNumber is deliberately ignored: @lid is not a phone.
 */
export function normalizeQrGroupEvents(payload: unknown, expectedInstance: string): QrGroupEvent[] {
  const envelope = object(payload);
  if (envelope.instance !== expectedInstance) throw new Error('QR_INSTANCE_MISMATCH');
  const event = String(envelope.event).toLowerCase().replace(/_/gu, '.');
  if (!['groups.upsert', 'groups.update', 'group.participants.update', 'group-participants.update'].includes(event)) return [];
  try {
    const senderJid = participantJid.parse(envelope.sender);
    const providerEmittedAt = z.iso.datetime({ offset: true }).parse(envelope.date_time);
    const items = Array.isArray(envelope.data) ? envelope.data : [envelope.data];
    if (items.length === 0 || items.length > 100) throw new Error();
    return items.map(item => {
      const data = object(item), group = groupJid.parse(data.id);
      const participantsRaw = data.participants ?? [];
      if (!Array.isArray(participantsRaw) || participantsRaw.length > 2000) throw new Error();
      const participants = participantsRaw.map(value => participantJid.parse(typeof value === 'string' ? value : object(value).id));
      if (new Set(participants).size !== participants.length) throw new Error();
      const authorJid = data.author === undefined ? null : participantJid.parse(data.author);
      const metadata: QrGroupEvent['metadata'] = {};
      if (data.subject !== undefined) metadata.subject = z.string().trim().min(1).max(256).parse(data.subject);
      if (data.owner !== undefined) metadata.ownerJid = participantJid.parse(data.owner);
      if (data.subjectOwner !== undefined) metadata.subjectAuthorJid = participantJid.parse(data.subjectOwner);
      for (const key of ['announce', 'restrict', 'isCommunity', 'isCommunityAnnounce'] as const) {
        if (data[key] !== undefined) metadata[key] = z.boolean().parse(data[key]);
      }
      if (data.linkedParent !== undefined) metadata.linkedParent = data.linkedParent === null ? null : groupJid.parse(data.linkedParent);
      const kind = event === 'groups.upsert' ? 'UPSERT' : event === 'groups.update' ? 'UPDATE' : action.parse(data.action).toUpperCase() as QrGroupEvent['action'];
      return { kind: 'group' as const, action: kind, groupJid: group, providerEmittedAt, senderJid, authorJid, participants, metadata };
    });
  } catch { throw Object.assign(new Error('QR_GROUP_EVENT_INVALID'), { code: 'QR_GROUP_EVENT_INVALID', status: 422 }); }
}
