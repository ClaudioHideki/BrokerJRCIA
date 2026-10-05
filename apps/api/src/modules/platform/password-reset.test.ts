import {expect,it} from 'vitest';
import {PasswordResetInputSchema,passwordResetConfirmation,verifyPasswordResetConfirmation,type PasswordResetState} from './password-reset.js';
const state:PasswordResetState={userId:'11111111-1111-4111-8111-111111111111',email:'person@example.test',status:'ACTIVE',authVersion:0,organizations:[]};
it('binds expiring confirmation to actor, identity, credential generation and all company relationships',()=>{
 const key=Buffer.alloc(32,1),now=1800000000000,token=passwordResetConfirmation(key,'actor',state,now);
 expect(verifyPasswordResetConfirmation(key,'actor',state,token,now)).toBe('VALID');
 expect(verifyPasswordResetConfirmation(key,'actor',state,token,now+300000)).toBe('EXPIRED');
 for(const changed of [{...state,authVersion:1},{...state,email:'other@example.test'},{...state,status:'DISABLED' as const},{...state,organizations:[{id:state.userId,name:'Company',role:'ADMIN' as const,status:'ACTIVE' as const,membershipStatus:'ACTIVE' as const}]}])expect(verifyPasswordResetConfirmation(key,'actor',changed,token,now)).toBe('CHANGED');
 expect(verifyPasswordResetConfirmation(key,'other',state,token,now)).toBe('CHANGED');
 expect(verifyPasswordResetConfirmation(key,'actor',state,'untrusted',now)).toBe('CHANGED');
});
it('enforces the existing password bounds without trimming password contents',()=>{
 const input={password:' synthetic pass ',confirmationEmail:' PERSON@example.test ',confirmationToken:'proof'};
 expect(PasswordResetInputSchema.parse(input)).toEqual({...input,confirmationEmail:'person@example.test'});
 for(const password of ['short','x'.repeat(257)])expect(PasswordResetInputSchema.safeParse({...input,password}).success).toBe(false);
 expect(PasswordResetInputSchema.safeParse({...input,organizationId:state.userId}).success).toBe(false);
});
