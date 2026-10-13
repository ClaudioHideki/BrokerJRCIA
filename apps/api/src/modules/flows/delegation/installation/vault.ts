import {z} from 'zod';
import {createIntegrationSecrets} from '../../../integrations/secrets.js';
const context=z.strictObject({organizationId:z.uuid(),id:z.uuid(),generation:z.number().int().positive(),purpose:z.enum(['FLOW_INSTALLATION_CALLBACK','FLOW_INSTALLATION_RESPONSE'])});
type Context=z.infer<typeof context>;
export function createInstallationVault(serialized:string){
 const raw=z.record(z.string().regex(/^[1-9][0-9]*$/),z.string()).parse(JSON.parse(serialized));
 const versions=Object.keys(raw).map(Number).sort((a,b)=>a-b);if(!versions.length||versions.some(v=>!Number.isSafeInteger(v)))throw new Error('FLOW_INSTALLATION_KEYRING_INVALID');
 const keys=new Map(versions.map(v=>[v,createIntegrationSecrets(raw[String(v)]!)])),active=versions.at(-1)!;
 const aad=(c:Context,v:number)=>`${c.organizationId}:${c.purpose}:${c.id}:generation-${c.generation}:key-${v}`;
 return {seal(c:Context,value:string){context.parse(c);return {encrypted:keys.get(active)!.encrypt(aad(c,active),value),keyVersion:active};},
  open(c:Context,value:{encrypted:string;keyVersion:number}){context.parse(c);const key=keys.get(value.keyVersion);if(!key)throw new Error('FLOW_INSTALLATION_CIPHER_UNAVAILABLE');return key.decrypt(aad(c,value.keyVersion),value.encrypted);}};
}
