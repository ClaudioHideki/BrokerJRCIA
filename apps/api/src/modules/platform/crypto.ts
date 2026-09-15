import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function encryptSeed(seed: Buffer, key: Buffer): string {
 const iv=randomBytes(12); const c=createCipheriv('aes-256-gcm',key,iv);
 return Buffer.concat([iv,c.update(seed),c.final(),c.getAuthTag()]).toString('base64');
}
export function decryptSeed(value: string, key: Buffer): Buffer {
 const b=Buffer.from(value,'base64'); const d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));
 d.setAuthTag(b.subarray(-16)); return Buffer.concat([d.update(b.subarray(12,-16)),d.final()]);
}
export function totp(seed: Buffer, counter: number): string {
 const b=Buffer.alloc(8); b.writeBigUInt64BE(BigInt(counter)); const h=createHmac('sha1',seed).update(b).digest();
 const offset=h[h.length-1]! & 15; return ((h.readUInt32BE(offset)&0x7fffffff)%1000000).toString().padStart(6,'0');
}
export function verifyTotp(seed: Buffer, code: string, now: number, last: number): number|null {
 if(!/^\d{6}$/.test(code)) return null;
 const current=Math.floor(now/30000);
 for(const step of [current,current-1,current+1]) if(step>last && timingSafeEqual(Buffer.from(totp(seed,step)),Buffer.from(code))) return step;
 return null;
}
export function base32(seed: Buffer): string {
 let bits=''; for(const byte of seed) bits+=byte.toString(2).padStart(8,'0');
 return bits.match(/.{1,5}/g)!.map(b=>'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[parseInt(b.padEnd(5,'0'),2)]).join('');
}
