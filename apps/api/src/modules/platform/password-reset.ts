import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const PasswordResetInputSchema = z.strictObject({
 password: z.string().min(12).max(256),
 confirmationEmail: z.string().trim().toLowerCase().email().max(254),
 confirmationToken: z.string().min(1).max(256),
});
export const PasswordResetPreviewSchema = z.strictObject({
 userId: z.uuid(), email: z.email(), status: z.enum(['ACTIVE','DISABLED']),
 confirmationToken: z.string(),
 organizations: z.array(z.strictObject({
  id: z.uuid(), name: z.string(), role: z.enum(['OWNER','ADMIN','OPERATOR','VIEWER']),
  status: z.enum(['ACTIVE','SUSPENDED','DISABLED']), membershipStatus: z.enum(['ACTIVE','DISABLED']),
 })),
});
export type PasswordResetState = Omit<z.infer<typeof PasswordResetPreviewSchema>, 'confirmationToken'> & {authVersion:number};
const TTL_MS=5*60*1000;
function signature(key:Buffer,actorId:string,state:PasswordResetState,expires:number) {
 return createHmac('sha256',key).update('jrc:user-password-reset:v1\0').update(JSON.stringify({actorId,state,expires})).digest('base64url');
}
export function passwordResetConfirmation(key:Buffer,actorId:string,state:PasswordResetState,now=Date.now()) {
 const expires=now+TTL_MS;
 return `${expires}.${signature(key,actorId,state,expires)}`;
}
export function verifyPasswordResetConfirmation(key:Buffer,actorId:string,state:PasswordResetState,token:string,now=Date.now()):'VALID'|'EXPIRED'|'CHANGED' {
 const match=/^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(token);
 if(!match)return 'CHANGED';
 const expires=Number(match[1]);
 const expected=signature(key,actorId,state,expires);
 if(!timingSafeEqual(Buffer.from(expected),Buffer.from(match[2]!)))return 'CHANGED';
 if(expires<=now||expires>now+TTL_MS)return 'EXPIRED';
 return 'VALID';
}
