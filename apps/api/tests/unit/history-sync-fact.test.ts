import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { historyFactHash } from '../../src/modules/history-sync/writer.js';
import type { HistorySyncRecord } from '../../src/modules/history-sync/contract.js';

it('deduplicates a media fact by immutable content rather than the storage reference allocated on recapture', () => {
  const fact: Extract<HistorySyncRecord, {kind:'MESSAGE'}> = {
    kind:'MESSAGE',recipientKind:'INDIVIDUAL',chatJid:`${'1'.repeat(11)}@s.whatsapp.net`,
    providerMessageId:'synthetic-recaptured-media',fromMe:false,participantJid:null,
    messageTimestamp:1600000000,displayName:null,state:'SENT',
    content:{type:'MEDIA',referenceId:randomUUID(),mediaType:'DOCUMENT',sha256:'a'.repeat(64),
      byteSize:8,mimeType:'text/plain',filename:'synthetic.txt',caption:'Synthetic caption'},
  };
  if(fact.content.type!=='MEDIA')throw Error('Expected media fixture');
  expect(historyFactHash({...fact,content:{...fact.content,referenceId:randomUUID()}})).toBe(historyFactHash(fact));
  expect(historyFactHash({...fact,content:{...fact.content,sha256:'b'.repeat(64)}})).not.toBe(historyFactHash(fact));
  expect(historyFactHash({...fact,content:{...fact.content,caption:'Changed caption'}})).not.toBe(historyFactHash(fact));
  expect(historyFactHash({...fact,fromMe:true})).not.toBe(historyFactHash(fact));
});
