import {createHash,randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {parseHistorySnapshot,parseHistoryPage,historySnapshotFingerprint} from '../../src/modules/history-import/contract.js';

const now=new Date('2026-10-17T12:00:00.000Z');
const scope={organizationId:randomUUID(),channelId:randomUUID(),sourceRevision:3,sourceFingerprint:'a'.repeat(64)};
const record=(ordinal:number)=>({ordinal,providerMessageId:`history-${ordinal}`,remoteJid:'15550000001@s.whatsapp.net',
  fromMe:ordinal%2===0,messageTimestamp:1792234800,text:`Synthetic ${ordinal}`,displayName:null});
const hash=(records:unknown[])=>createHash('sha256').update(JSON.stringify(records)).digest('hex');
function fixture(total=2){
 const records=Array.from({length:total},(_,i)=>record(i));
 const pageDigests=[];for(let i=0;i<total;i+=100)pageDigests.push(hash(records.slice(i,i+100)));
 const manifest={schemaVersion:1,snapshotId:randomUUID(),...scope,from:'2026-10-17T10:00:00.000Z',to:'2026-10-17T12:00:00.000Z',
   expiresAt:'2026-10-18T12:00:00.000Z',totalRecords:total,pageSize:100,pageDigests};
 return{manifest,records,page:{schemaVersion:1,snapshotId:manifest.snapshotId,startOrdinal:0,records:records.slice(0,100)}};
}
const parse=(value:unknown,budget=1000)=>parseHistorySnapshot(value,scope,budget,now);

describe('immutable history snapshot v1',()=>{
 it('accepts a frozen scoped snapshot and preserves direction, ID and timestamp',()=>{
  const f=fixture();const snapshot=parse(f.manifest);
  expect(parseHistoryPage(snapshot,0,f.page,now)).toMatchObject({records:f.records,nextOrdinal:2,complete:true});
 });
 it('accepts an empty snapshot but does not request an empty page',()=>{
  const f=fixture(0);const snapshot=parse(f.manifest);expect(snapshot.totalRecords).toBe(0);
  expect(()=>parseHistoryPage(snapshot,0,f.page,now)).toThrow('HISTORY_PAGE_NOT_EXPECTED');
 });
 it.each(['organizationId','channelId','sourceRevision','sourceFingerprint'] as const)('rejects a changed %s',key=>{
  const f=fixture();const changed={...f.manifest,[key]:key==='sourceRevision'?4:key==='sourceFingerprint'?'b'.repeat(64):randomUUID()};
  expect(()=>parse(changed)).toThrow('HISTORY_SNAPSHOT_SCOPE_CHANGED');
 });
 it('refuses an unsupported contract instead of using mutable provider pages',()=>{
  expect(()=>parse({...fixture().manifest,schemaVersion:2})).toThrow('HISTORY_SNAPSHOT_INVALID');
 });
 it('rejects an expired snapshot at start and before persisting a page',()=>{
  const f=fixture();expect(()=>parse({...f.manifest,expiresAt:now.toISOString()})).toThrow('HISTORY_SNAPSHOT_EXPIRED');
  const snapshot=parse(f.manifest);expect(()=>parseHistoryPage(snapshot,0,f.page,new Date(f.manifest.expiresAt))).toThrow('HISTORY_SNAPSHOT_EXPIRED');
 });
 it('rejects a count beyond the approved budget and invalid budgets',()=>{
  const f=fixture();expect(()=>parse(f.manifest,1)).toThrow('HISTORY_IMPORT_BUDGET');
  expect(()=>parse(f.manifest,0)).toThrow('HISTORY_IMPORT_BUDGET');
 });
 it('rejects an oversized otherwise count-consistent manifest before processing it',()=>{
  const f=fixture();const pageDigests=Array(20_000).fill('a'.repeat(64));
  expect(()=>parse({...f.manifest,totalRecords:2_000_000,pageDigests},2_000_000)).toThrow('HISTORY_SNAPSHOT_INVALID');
 });
 it('rejects reversed intervals and an invalid caller clock',()=>{
  const f=fixture();expect(()=>parse({...f.manifest,from:f.manifest.to,to:f.manifest.from})).toThrow('HISTORY_SNAPSHOT_INVALID');
  expect(()=>parseHistorySnapshot(f.manifest,scope,1000,new Date('invalid'))).toThrow('HISTORY_SNAPSHOT_EXPIRED');
 });
 it('requires one digest per fixed page, including the final partial page',()=>{
  const f=fixture(101);expect(()=>parse({...f.manifest,pageDigests:f.manifest.pageDigests.slice(0,1)})).toThrow('HISTORY_SNAPSHOT_INVALID');
  const snapshot=parse(f.manifest);const last={schemaVersion:1,snapshotId:manifestId(snapshot),startOrdinal:100,records:f.records.slice(100)};
  expect(parseHistoryPage(snapshot,100,last,now)).toMatchObject({nextOrdinal:101,complete:true});
 });
 it('rejects partial or empty pages before the frozen total',()=>{
  const f=fixture(101),snapshot=parse(f.manifest);
  expect(()=>parseHistoryPage(snapshot,0,{...f.page,records:f.records.slice(0,99)},now)).toThrow('HISTORY_PAGE_INVALID');
  expect(()=>parseHistoryPage(snapshot,0,{...f.page,records:[]},now)).toThrow('HISTORY_PAGE_INVALID');
 });
 it('rejects page replay at another checkpoint and pages from another snapshot',()=>{
  const f=fixture(),snapshot=parse(f.manifest);
  expect(()=>parseHistoryPage(snapshot,1,f.page,now)).toThrow('HISTORY_PAGE_SCOPE_CHANGED');
  expect(()=>parseHistoryPage(snapshot,0,{...f.page,snapshotId:randomUUID()},now)).toThrow('HISTORY_PAGE_SCOPE_CHANGED');
 });
 it('detects a modified record against the frozen digest',()=>{
  const f=fixture(),snapshot=parse(f.manifest);
  expect(()=>parseHistoryPage(snapshot,0,{...f.page,records:[{...f.records[0],text:'tampered'},f.records[1]]},now)).toThrow('HISTORY_PAGE_DIGEST_MISMATCH');
 });
 it('rejects reordered or repeated ordinals before any persistence',()=>{
  const f=fixture(),snapshot=parse(f.manifest);
  expect(()=>parseHistoryPage(snapshot,0,{...f.page,records:[f.records[1],f.records[0]]},now)).toThrow('HISTORY_PAGE_INVALID');
  expect(()=>parseHistoryPage(snapshot,0,{...f.page,records:[f.records[0],f.records[0]]},now)).toThrow('HISTORY_PAGE_INVALID');
 });
 it('rejects unsupported media/groups and records outside the selected interval explicitly',()=>{
  const f=fixture(),snapshot=parse(f.manifest);
  for(const patch of [{media:{id:'unsupported'}},{remoteJid:'12345@g.us'},{messageTimestamp:1}]){
   expect(()=>parseHistoryPage(snapshot,0,{...f.page,records:[{...f.records[0],...patch},f.records[1]]},now)).toThrow('HISTORY_PAGE_INVALID');
  }
 });
 it('fingerprints the entire frozen scope, count and page digest list canonically',()=>{
  const f=fixture();const first=parse(f.manifest);const reversed=parse(Object.fromEntries(Object.entries(f.manifest).reverse()));
  expect(historySnapshotFingerprint(first)).toMatch(/^[a-f0-9]{64}$/);
  expect(historySnapshotFingerprint(first)).toBe(historySnapshotFingerprint(reversed));
  expect(historySnapshotFingerprint(first)).not.toBe(historySnapshotFingerprint(parse({...f.manifest,pageDigests:['b'.repeat(64)]})));
 });
});
function manifestId(value:{snapshotId:string}){return value.snapshotId;}

it('rejects a seven-digit phone that the QR normalizer cannot resolve',()=>{
 const f=fixture(1);f.records[0]!.remoteJid='1234567@s.whatsapp.net';f.manifest.pageDigests=[hash(f.records)];
 expect(()=>parseHistoryPage(parse(f.manifest),0,f.page,now)).toThrow('HISTORY_PAGE_INVALID');
});
