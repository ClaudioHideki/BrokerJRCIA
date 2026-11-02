/** Only source notify TEXT facts that the existing Broker individual normalizer accepts. */
export function projectTextBatch(binding, events) {
  const upsert = events?.['messages.upsert'];
  if (!upsert || upsert.type !== 'notify') return [];
  if (!Array.isArray(upsert.messages) || upsert.messages.length > 100) throw new Error('ORIGIN_TEXT_INVALID');
  const facts = [];
  for (const item of upsert.messages) {
    const key = item?.key;
    if (!key || typeof key.remoteJid !== 'string' || !/^[1-9]\d{7,14}@s\.whatsapp\.net$/u.test(key.remoteJid)) continue;
    const message = item?.message;
    if (message && ['protocolMessage', 'editedMessage', 'reactionMessage', 'senderKeyDistributionMessage', 'imageMessage', 'audioMessage', 'videoMessage', 'documentMessage', 'stickerMessage'].some(name => message[name] !== undefined)) continue;
    const text = message?.conversation ?? message?.extendedTextMessage?.text;
    if (text === undefined) continue;
    const rawTime = item.messageTimestamp;
    let timestamp = rawTime;
    if (rawTime && typeof rawTime === 'object' && Number.isInteger(rawTime.low) && Number.isInteger(rawTime.high)
      && rawTime.low >= -2147483648 && rawTime.low <= 2147483647 && rawTime.high >= 0 && rawTime.high <= 2147483647) {
      timestamp = Number((BigInt(rawTime.high) << 32n) + BigInt(rawTime.low >>> 0));
    }
    if (typeof key.id !== 'string' || !key.id.length || key.id.length > 256 || typeof key.fromMe !== 'boolean'
      || typeof text !== 'string' || !text.length || text.length > 4096
      || !Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > 253402300799
      || typeof binding?.instanceName !== 'string' || !binding.instanceName.length || binding.instanceName.length > 255) throw new Error('ORIGIN_TEXT_INVALID');
    facts.push({ event: 'messages.upsert', instance: binding.instanceName,
      data: { key: { id: key.id, fromMe: key.fromMe, remoteJid: key.remoteJid },
        message: { conversation: text }, messageTimestamp: timestamp } });
  }
  return facts;
}

export function canonicalText(binding, envelope) {
  const selected = projectTextBatch(binding, { 'messages.upsert': { type: 'notify', messages: [envelope?.data] } });
  if (selected.length !== 1 || envelope?.event !== 'messages.upsert' || envelope?.instance !== binding.instanceName
    || JSON.stringify(selected[0]) !== JSON.stringify(envelope)) throw new Error('ORIGIN_TEXT_INVALID');
  return selected[0];
}
