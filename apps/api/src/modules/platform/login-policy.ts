export interface PlatformLoginPolicy {mode?:string;localPasswordOnly?:string;nodeEnv?:string;origin?:string}
export function platformMfaRequired(policy:PlatformLoginPolicy):boolean {
 if (policy.mode) {
  if (!['password','password_totp'].includes(policy.mode)) throw new Error('INVALID_PLATFORM_LOGIN_POLICY');
  if (policy.mode === 'password_totp') return true;
  const origin = new URL(policy.origin ?? '');
  const local = policy.nodeEnv !== 'production' && origin.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(origin.hostname);
  if (origin.origin !== policy.origin || (origin.protocol !== 'https:' && !local)) throw new Error('PLATFORM_PASSWORD_LOGIN_REQUIRES_HTTPS');
  return false;
 }
 if(policy.localPasswordOnly===undefined||policy.localPasswordOnly===''||policy.localPasswordOnly==='false')return true;
 if(policy.localPasswordOnly!=='true')throw new Error('INVALID_PLATFORM_LOGIN_POLICY');
 const origin=new URL(policy.origin??'');
 if(policy.nodeEnv!=='development'||origin.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)||origin.origin!==policy.origin)
  throw new Error('PASSWORD_ONLY_REQUIRES_LOCAL_DEVELOPMENT');
 return false;
}
