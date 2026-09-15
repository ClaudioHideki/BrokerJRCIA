import {expect,it} from 'vitest';
import {platformMfaRequired} from './login-policy.js';
it('requires MFA by default and permits password-only only on explicit local development',()=>{
 expect(platformMfaRequired({})).toBe(true);
 expect(platformMfaRequired({localPasswordOnly:'true',nodeEnv:'development',origin:'http://127.0.0.1:8088'})).toBe(false);
 for(const input of [
  {localPasswordOnly:'true',nodeEnv:'production',origin:'http://127.0.0.1:8088'},
  {localPasswordOnly:'true',nodeEnv:'development',origin:'https://broker.example.com'},
  {localPasswordOnly:'invalid',nodeEnv:'development',origin:'http://localhost:8088'},
 ])expect(()=>platformMfaRequired(input)).toThrow();
});
it('supports the requested email/password login on an explicitly configured HTTPS server',()=>{
 expect(platformMfaRequired({mode:'password',nodeEnv:'production',origin:'https://broker.example.com'})).toBe(false);
 expect(platformMfaRequired({mode:'password_totp',nodeEnv:'production',origin:'https://broker.example.com'})).toBe(true);
 expect(()=>platformMfaRequired({mode:'password',nodeEnv:'production',origin:'http://broker.example.com'})).toThrow();
 expect(()=>platformMfaRequired({mode:'password',nodeEnv:'production',origin:'https://user:pass@broker.example.com/path'})).toThrow();
 expect(()=>platformMfaRequired({mode:'invalid',nodeEnv:'production',origin:'https://broker.example.com'})).toThrow();
});
