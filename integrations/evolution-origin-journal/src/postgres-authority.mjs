import {createCipheriv,createDecipheriv,createHmac,randomBytes} from 'node:crypto';
import {createOriginJournal} from './journal.mjs';

const uuid=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu;
const sameHost=(a,b)=>a?.engineId===b?.engineId&&a?.generation===b?.generation&&a?.engineFingerprint===b?.engineFingerprint;
const ownerAad=id=>Buffer.from(JSON.stringify(['history-source-owner:2',id]));
export function openSourceOwner(key,id,proof){
  try{
    const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(proof.iv,'base64'));
    decipher.setAAD(ownerAad(id));decipher.setAuthTag(Buffer.from(proof.tag,'base64'));
    const bytes=Buffer.concat([decipher.update(Buffer.from(proof.ciphertext,'base64')),decipher.final()]);
    try{const phone=bytes.toString('utf8');if(!/^[1-9]\d{7,14}$/u.test(phone))throw Error();return phone;}finally{bytes.fill(0);}
  }catch{throw Error('HISTORY_SOURCE_OWNER_UNAVAILABLE');}
}
function sealOwner(key,id,phone){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),bytes=Buffer.from(phone);
  cipher.setAAD(ownerAad(id));
  try{const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]).toString('base64');
    return{iv:iv.toString('base64'),ciphertext,tag:cipher.getAuthTag().toString('base64')};}finally{bytes.fill(0);}
}
/** Trusted database principal, not a caller-provided ownership boolean. No auth
 * state is stored: only an HMAC of the native registration identity is retained.
 * This authority does not assert that a real phone/session has been homologated. */
export function createPostgresOriginAuthority({pool,encryptionKey,engine,maxStagedBytes}){
  if(!pool||!Buffer.isBuffer(encryptionKey)||encryptionKey.length!==32
    ||!Number.isSafeInteger(maxStagedBytes)||maxStagedBytes<1||maxStagedBytes>128*1024*1024
    ||!Number.isSafeInteger(engine?.generation)||engine.generation<1||!/^[a-z][a-z0-9_-]{0,63}$/u.test(engine.engineId)
    ||!/^[a-f0-9]{64}$/u.test(engine.engineFingerprint))throw Error('ORIGIN_HOST_CONFIGURATION_INVALID');
  const key=Buffer.from(encryptionKey),expected=Object.freeze({...engine});
  const verify=async()=>{
    const health=(await pool.query("SELECT current_setting('fsync')='on' AND current_setting('full_page_writes')='on' AND to_regclass('jrc_evolution_origin.history_media') IS NOT NULL AS ready")).rows[0];
    const host=(await pool.query('SELECT history_origin_host_identity() AS host')).rows[0]?.host;
    if(health?.ready!==true||!sameHost(host,expected))throw Error('HISTORY_SOURCE_HOST_UNREGISTERED');
  };
  return Object.freeze({verify,async prepare(scope,instance){
    if(!uuid.test(scope?.instanceId)||instance?.instance?.id!==scope.instanceId||instance?.instance?.name!==scope.instanceName)
      throw Error('ORIGIN_ENGINE_BINDING_CHANGED');
    const registration=instance.instance.authState?.state?.creds?.registrationId;
    if(!Number.isSafeInteger(registration)||registration<0||registration>2147483647)throw Error('ORIGIN_ENGINE_AUTH_NOT_READY');
    const sessionFingerprint=createHmac('sha256',key).update(JSON.stringify(['source-session:2',expected.engineId,scope.instanceId,registration])).digest('hex');
    await verify();
    const admission=(await pool.query('SELECT history_source_open($1,$2,$3) AS admission',[scope.instanceName,scope.instanceId,sessionFingerprint])).rows[0]?.admission;
    if(admission?.mode==='LEGACY')return Object.freeze({mode:'LEGACY'});
    if(admission?.mode!=='CAPTURE'||!uuid.test(admission.sessionId)||admission.binding.instanceId!==scope.instanceId
      ||admission.binding.instanceName!==scope.instanceName)throw Error('ORIGIN_ENGINE_BINDING_CHANGED');
    const assertTransaction=client=>client.query('SELECT history_source_assert($1)',[admission.sessionId]);
    const journal=createOriginJournal({pool,encryptionKey:key,assertTransaction,liveVersion:2,history:{maxStagedBytes,captureMedia:true}});
    return Object.freeze({mode:'CAPTURE',admission,journal,assertTransaction,
      async assert(){await pool.query('SELECT history_source_assert($1)',[admission.sessionId]);return admission.binding;},
      async observeOwner(socketOwnerJid){
        // Snapshot before awaiting PostgreSQL. Never infer owner from an incoming
        // message, pushName, browser selection or legacy cache record.
        const jid=socketOwnerJid??instance.instance.authState?.state?.creds?.me?.id;
        if(jid===undefined||jid===null)return false;
        const match=/^([1-9]\d{7,14})(?::\d+)?@s\.whatsapp\.net$/u.exec(jid);
        if(!match)throw Error('HISTORY_SOURCE_OWNER_UNAVAILABLE');
        const stored=(await pool.query('SELECT history_source_owner($1) AS proof',[admission.sessionId])).rows[0]?.proof;
        if(stored&&openSourceOwner(key,admission.sessionId,stored)!==match[1])throw Error('HISTORY_SOURCE_OWNER_CHANGED');
        await pool.query('SELECT history_source_bind_owner($1,$2)',[admission.sessionId,stored??sealOwner(key,admission.sessionId,match[1])]);
        return true;
      },
    });
  }});
}
