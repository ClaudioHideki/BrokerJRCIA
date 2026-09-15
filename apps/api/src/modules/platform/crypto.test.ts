import { expect, it } from 'vitest';
import { encryptSeed, decryptSeed, totp, verifyTotp } from './crypto.js';
it('uses RFC 6238 TOTP and rejects replay and wrong codes', () => {
 const seed = Buffer.from('12345678901234567890');
 expect(totp(seed, 1)).toBe('287082');
 expect(verifyTotp(seed,'287082',59000,-1)).toBe(1);
 expect(verifyTotp(seed,'287082',59000,1)).toBeNull();
 expect(verifyTotp(seed,'000000',59000,-1)).toBeNull();
});
it('authenticates encrypted MFA seeds', () => {
 const key=Buffer.alloc(32,3); const encrypted=encryptSeed(Buffer.from('secret'),key);
 expect(decryptSeed(encrypted,key).toString()).toBe('secret');
 expect(()=>decryptSeed(encrypted,Buffer.alloc(32,4))).toThrow();
});
