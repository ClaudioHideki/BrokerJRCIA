import type { LifecycleTransaction } from '../lifecycle/service.js';
import {createPrivateMediaRuntime} from './private-media-runtime.js';
import {createPrivateMediaCleanup} from './private-media-cleanup.js';
export function createLifecycleMediaRuntime(environment: NodeJS.ProcessEnv, transact: LifecycleTransaction) {
  let dedicated=false;
  try { dedicated=new URL(environment.LIFECYCLE_DATABASE_URL??'').username==='jrc_lifecycle'; } catch {}
  if(!dedicated)throw new Error('LIFECYCLE_WORKER_REQUIRES_DEDICATED_ROLE');
  const privateMedia=createPrivateMediaRuntime(environment,{cleanupTransact:transact,
    transact:async()=>{throw new Error('PRIVATE_MEDIA_LIFECYCLE_CANNOT_USE_APP_TRANSACTION');}});
  return createPrivateMediaCleanup(transact,privateMedia);
}
