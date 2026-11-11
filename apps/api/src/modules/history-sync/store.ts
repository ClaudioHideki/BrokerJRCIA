import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { HistorySyncCommandSchema, HistorySyncStartSchema } from '@jrc/contracts';
import type { OrganizationTransaction, TenantTransaction } from '../../db/tenant-transaction.js';
import { hashIdempotencyRequest } from '../instances/idempotency.js';
import { HistorySyncScopeSchema, parseHistorySyncSourceChunk, type HistorySyncScope } from './contract.js';

type Row = { id:string; organization_id:string; channel_id:string; instance_id:string; request_hash:string;
  engine_id:string; engine_generation:string; session_generation:string; binding_fingerprint:string;
  history_account_identity:string|null; identity_scope_id:string|null; owner_fingerprint:string|null;
  state:string; capture:string; revision:string; last_error:string|null; categories:string[] };
type Envelope = {version:1; iv:string; tag:string; ciphertext:string};
interface Options {
  transact<T>(org:string, work:OrganizationTransaction<T>):Promise<T>;
  encryptionKey:Buffer;
  /** Private, measured tenant staging budget supplied by the host; never a browser setting. */
  maxStagedBytes:number;
  /** Host must authenticate source, check current ownership/binding and hold its revocation fence through COMMIT. */
  assertCurrentScope(tx:TenantTransaction, scope:HistorySyncScope):Promise<void>;
}
function failure(code:string):never {throw new Error(code);}
const view = (row:Row) => ({id:row.id,organizationId:row.organization_id,channelId:row.channel_id,
  instanceId:row.instance_id,state:row.state,capture:row.capture,historyAccountIdentity:row.history_account_identity,
  revision:Number(row.revision),lastError:row.last_error});
const scopeOf = (row:Row):HistorySyncScope => ({organizationId:row.organization_id,channelId:row.channel_id,instanceId:row.instance_id,
  engineId:row.engine_id,engineGeneration:Number(row.engine_generation),sessionGeneration:row.session_generation,
  bindingFingerprint:row.binding_fingerprint,identityScopeId:row.identity_scope_id,
  historyAccountIdentity:row.history_account_identity,ownerFingerprint:row.owner_fingerprint});
const captureKey = (s:HistorySyncScope) => hashIdempotencyRequest({...s,identityScopeId:null,historyAccountIdentity:null,ownerFingerprint:null});

/** Private staging core. Not mounted as an API or admitted automatically; it never emits a final import ACK. */
export function createHistorySyncStore(options:Options) {
  if (!Buffer.isBuffer(options.encryptionKey) || options.encryptionKey.length!==32
    || !Number.isSafeInteger(options.maxStagedBytes) || options.maxStagedBytes<1) failure('HISTORY_SYNC_CONFIG_INVALID');
  const key=Buffer.from(options.encryptionKey);
  const aad=(org:string,run:string,chunk:string,scopeHash:string)=>Buffer.from(JSON.stringify(['history-sync:v2',org,run,chunk,scopeHash]));
  const seal=(data:unknown,authenticatedData:Buffer):Envelope=>{
    const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv);
    cipher.setAAD(authenticatedData);
    const ciphertext=Buffer.concat([cipher.update(JSON.stringify(data),'utf8'),cipher.final()]);
    return {version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
  };
  const open=(envelope:Envelope,authenticatedData:Buffer):unknown=>{
    try {
      if(envelope.version!==1) throw Error();
      const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));
      decipher.setAAD(authenticatedData); decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString('utf8'));
    } catch {return failure('HISTORY_SYNC_PRIVATE_PAYLOAD_INVALID');}
  };
  const read=async(tx:TenantTransaction,org:string,id:string,lock=false)=>(await tx.query<Row>(
    `SELECT * FROM history_sync_runs WHERE organization_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[org,id])).rows[0];
  const catalog=async(tx:TenantTransaction,scope:HistorySyncScope)=>{
    if(!scope.historyAccountIdentity) return null;
    const result=await tx.query<{id:string}>(`INSERT INTO history_account_identities(organization_id,id,channel_id,owner_fingerprint)
      VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,channel_id,owner_fingerprint)
      DO UPDATE SET owner_fingerprint=EXCLUDED.owner_fingerprint RETURNING id`,
    [scope.organizationId,scope.historyAccountIdentity,scope.channelId,scope.ownerFingerprint]);
    return result.rows[0]!.id;
  };
  return {
    async admit(rawScope:HistorySyncScope,requestId:string,rawSelection:unknown,now:Date) {
      const scope=Object.freeze(HistorySyncScopeSchema.parse(rawScope)), selection=HistorySyncStartSchema.parse(rawSelection);
      if(!Number.isFinite(now.getTime())) failure('HISTORY_SYNC_CLOCK_INVALID');
      const requestHash=hashIdempotencyRequest({scope,selection});
      return options.transact(scope.organizationId,async tx=>{
        await options.assertCurrentScope(tx,scope);
        const identity=await catalog(tx,scope);
        await tx.query(`INSERT INTO history_sync_runs(organization_id,channel_id,instance_id,request_id,request_hash,
          engine_id,engine_generation,session_generation,binding_fingerprint,categories,history_account_identity,identity_scope_id,owner_fingerprint,capture)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT(organization_id,channel_id,request_id) DO NOTHING`,
        [scope.organizationId,scope.channelId,scope.instanceId,requestId,requestHash,scope.engineId,scope.engineGeneration,
          scope.sessionGeneration,scope.bindingFingerprint,selection.categories,identity,scope.identityScopeId,scope.ownerFingerprint,
          identity?'CAPTURING':'WAITING_IDENTITY']);
        const row=(await tx.query<Row>('SELECT * FROM history_sync_runs WHERE organization_id=$1 AND channel_id=$2 AND request_id=$3 FOR UPDATE',
          [scope.organizationId,scope.channelId,requestId])).rows[0];
        if(!row || row.request_hash!==requestHash) failure('HISTORY_SYNC_REQUEST_CONFLICT');
        return view(row);
      });
    },
    async get(org:string,id:string) {return options.transact(org,async tx=>{const row=await read(tx,org,id); return row?view(row):null;});},
    async command(rawScope:HistorySyncScope,id:string,expectedRevision:number,command:'PAUSE'|'RESUME'|'CANCEL') {
      const scope=Object.freeze(HistorySyncScopeSchema.parse(rawScope));
      HistorySyncCommandSchema.parse({expectedRevision});
      if(!['PAUSE','RESUME','CANCEL'].includes(command)) failure('HISTORY_SYNC_COMMAND_INVALID');
      return options.transact(scope.organizationId,async tx=>{
        const row=await read(tx,scope.organizationId,id,true);
        if(!row) failure('HISTORY_SYNC_NOT_FOUND');
        await options.assertCurrentScope(tx,scope);
        if(hashIdempotencyRequest(scopeOf(row))!==hashIdempotencyRequest(scope)) failure('HISTORY_SYNC_SCOPE_CHANGED');
        if(Number(row.revision)!==expectedRevision) failure('HISTORY_SYNC_REVISION_CHANGED');
        if(['COMPLETED','CANCELED','BLOCKED'].includes(row.state)) failure('HISTORY_SYNC_TERMINAL');
        const target={PAUSE:'PAUSED',RESUME:'RUNNING',CANCEL:'CANCELED'}[command];
        const updated=(await tx.query<Row>(`UPDATE history_sync_runs SET state=$3,
          capture=CASE WHEN $3='RUNNING' AND capture='PARTIAL' THEN 'CAPTURING' ELSE capture END,
          last_error=CASE WHEN $3='RUNNING' THEN NULL ELSE last_error END,revision=revision+1,updated_at=now()
          WHERE organization_id=$1 AND id=$2 RETURNING *`,[scope.organizationId,id,target])).rows[0]!;
        return view(updated);
      });
    },
    async acceptChunk(expected:HistorySyncScope,runId:string,raw:unknown,now:Date) {
      const scope=Object.freeze(HistorySyncScopeSchema.parse(expected));
      const chunk=parseHistorySyncSourceChunk(raw,scope,now), org=scope.organizationId, scopeHash=hashIdempotencyRequest(chunk.scope);
      return options.transact(org,async tx=>{
        // A single tenant budget lock also serializes different runs competing for the same quota.
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,852))",[org]);
        const row=await read(tx,org,runId,true);
        if(!row) failure('HISTORY_SYNC_NOT_FOUND');
        await options.assertCurrentScope(tx,scope);
        if(captureKey(scopeOf(row))!==captureKey(scope)) failure('HISTORY_SYNC_SCOPE_CHANGED');
        const categories=new Set(row.categories);
        for(const record of chunk.records) {
          if((record.kind==='MESSAGE' || record.kind==='CHAT') && !categories.has(record.recipientKind)
            || record.kind==='MESSAGE' && record.content.type==='MEDIA' && !categories.has('MEDIA')
            || record.kind==='CONTACT' && !categories.has('INDIVIDUAL')
            || record.kind==='GAP' && record.chatJid!==null && !categories.has(record.chatJid.endsWith('@g.us')?'GROUP':'INDIVIDUAL'))
            failure('HISTORY_SYNC_CATEGORY_NOT_SELECTED');
        }
        const previous=(await tx.query<{chunk_id:string;scope_hash:string;private_payload:Envelope;state:string;admission_kind:'STAGED'|'VALIDATED'}>(
          'SELECT chunk_id,scope_hash,private_payload,state,admission_kind FROM history_sync_chunks WHERE organization_id=$1 AND run_id=$2 AND (chunk_id=$3 OR ordinal=$4)',
          [org,runId,chunk.chunkId,chunk.ordinal])).rows[0];
        if(previous) {
          if(previous.chunk_id!==chunk.chunkId || previous.scope_hash!==scopeHash
            || hashIdempotencyRequest(open(previous.private_payload,aad(org,runId,chunk.chunkId,scopeHash)))!==hashIdempotencyRequest(chunk))
            failure('HISTORY_SYNC_CHUNK_CONFLICT');
          if(previous.state==='QUARANTINED') failure('HISTORY_SYNC_SCOPE_CHANGED');
          // Receipt describes the original commit, even if the run was promoted subsequently.
          return {kind:previous.admission_kind,chunkId:chunk.chunkId,checksum:chunk.checksum} as const;
        }
        if(row.state!=='RUNNING') failure('HISTORY_SYNC_NOT_RUNNING');
        if(hashIdempotencyRequest(scopeOf(row))!==hashIdempotencyRequest(scope)) failure('HISTORY_SYNC_SCOPE_CHANGED');
        const envelope=seal(chunk,aad(org,runId,chunk.chunkId,scopeHash));
        const used=(await tx.query<{bytes:string;incoming:number}>(`SELECT COALESCE(sum(octet_length(private_payload::text)),0)::text AS bytes,
          octet_length($2::jsonb::text) AS incoming FROM history_sync_chunks WHERE organization_id=$1`,[org,JSON.stringify(envelope)])).rows[0]!;
        if(BigInt(used.bytes)+BigInt(used.incoming)>BigInt(options.maxStagedBytes)) {
          await tx.query(`UPDATE history_sync_runs SET state='PARTIAL',capture=CASE WHEN history_account_identity IS NULL THEN 'WAITING_IDENTITY' ELSE 'PARTIAL' END,
            last_error='HISTORY_SYNC_SOURCE_QUOTA',revision=revision+1,updated_at=$3 WHERE organization_id=$1 AND id=$2`,[org,runId,now]);
          return {kind:'GAP',chunkId:chunk.chunkId,reason:'SOURCE_QUOTA'} as const;
        }
        await tx.query(`INSERT INTO history_sync_chunks(organization_id,channel_id,run_id,chunk_id,ordinal,checksum,scope_hash,captured_at,is_last,progress,record_count,state,private_payload,admission_kind)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [org,row.channel_id,runId,chunk.chunkId,chunk.ordinal,chunk.checksum,scopeHash,chunk.capturedAt,chunk.isLast,chunk.progress,chunk.records.length,
          row.history_account_identity?'VALIDATED':'PROVISIONAL',envelope,row.history_account_identity?'VALIDATED':'STAGED']);
        return {kind:row.history_account_identity?'VALIDATED':'STAGED',chunkId:chunk.chunkId,checksum:chunk.checksum} as const;
      });
    },
    async promote(runId:string,rawConfirmed:HistorySyncScope,now:Date) {
      const confirmed=Object.freeze(HistorySyncScopeSchema.parse(rawConfirmed)),org=confirmed.organizationId;
      if(!confirmed.historyAccountIdentity) failure('HISTORY_SYNC_IDENTITY_REQUIRED');
      return options.transact(org,async tx=>{
        const row=await read(tx,org,runId,true);
        if(!row) failure('HISTORY_SYNC_NOT_FOUND');
        await options.assertCurrentScope(tx,confirmed);
        if(captureKey(scopeOf(row))!==captureKey(confirmed)
          || (row.owner_fingerprint!==null && row.owner_fingerprint!==confirmed.ownerFingerprint)) {
          await tx.query("UPDATE history_sync_chunks SET state='QUARANTINED' WHERE organization_id=$1 AND run_id=$2 AND state IN ('PROVISIONAL','VALIDATED')",[org,runId]);
          const blocked=(await tx.query<Row>(`UPDATE history_sync_runs SET state='BLOCKED',last_error='HISTORY_SYNC_SCOPE_CHANGED',revision=revision+1,updated_at=$3 WHERE organization_id=$1 AND id=$2 RETURNING *`,[org,runId,now])).rows[0]!;
          return view(blocked);
        }
        if(row.state!=='RUNNING') failure('HISTORY_SYNC_NOT_RUNNING');
        if(row.history_account_identity) return view(row);
        const identity=await catalog(tx,confirmed);
        await tx.query("UPDATE history_sync_chunks SET state='VALIDATED' WHERE organization_id=$1 AND run_id=$2 AND state='PROVISIONAL'",[org,runId]);
        const promoted=(await tx.query<Row>(`UPDATE history_sync_runs SET history_account_identity=$3,identity_scope_id=$4,owner_fingerprint=$5,
          capture='CAPTURING',revision=revision+1,updated_at=$6 WHERE organization_id=$1 AND id=$2 RETURNING *`,
        [org,runId,identity,confirmed.identityScopeId,confirmed.ownerFingerprint,now])).rows[0]!;
        return view(promoted);
      });
    },
  };
}
