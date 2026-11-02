/** This assertion is additional to (not proof of) a disposable, exclusive cluster. */
export function requireExclusiveLab(raw:string|undefined,exclusive:string|undefined,prefix:string):asserts raw is string{
 if(!raw||exclusive!=='1')throw Error(`${prefix}_REQUIRES_EXPLICIT_EXCLUSIVE_LAB_CLUSTER`);
 const url=new URL(raw);
 // pg-connection-string prioritizes query host/user over the URL authority.
 // No query options or fragments are permitted at this destructive-test boundary.
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.search||url.hash||
  !['127.0.0.1','[::1]'].includes(url.hostname)||
  !/^lab_[A-Za-z0-9_]+$/.test(decodeURIComponent(url.username))||
  !/^\/lab_[A-Za-z0-9_]+$/.test(decodeURIComponent(url.pathname)))throw Error(`${prefix}_REQUIRES_LOOPBACK_LAB_ADMIN`);
}
