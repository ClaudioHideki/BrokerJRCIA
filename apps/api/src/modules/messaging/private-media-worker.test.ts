import {expect,it,vi} from 'vitest';
import {recoverPrivateMedia,type PrivateMediaRecoveryOptions} from './private-media-worker.js';
const make=(extra:Partial<PrivateMediaRecoveryOptions>={})=>({mode:'automatic' as const,organizations:[],
  discover:vi.fn(async()=>['disabled-org']),runOnce:vi.fn(async()=>{}),belongsToShard:()=>true,...extra});
it('uses the private recovery directory for inactive work without granting any send or download port',async()=>{
  const p=make();await recoverPrivateMedia(p);expect(p.discover).toHaveBeenCalledWith(null,100);
  expect(p.runOnce).toHaveBeenCalledExactlyOnceWith('disabled-org');
});
it('paginates raw discovery across a complete page owned by another shard',async()=>{
  const page=Array.from({length:100},(_,i)=>`foreign-${i}`);
  const p=make({discover:vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce(['mine']),
    belongsToShard:id=>id==='mine'});await recoverPrivateMedia(p);
  expect(p.discover).toHaveBeenNthCalledWith(2,'foreign-99',100);
  expect(p.runOnce).toHaveBeenCalledExactlyOnceWith('mine');
});
it('honors the configured allowlist and shard without automatic discovery',async()=>{
  const p=make({mode:'allowlist',organizations:['mine','other'],belongsToShard:id=>id==='mine'});
  await recoverPrivateMedia(p);expect(p.discover).not.toHaveBeenCalled();
  expect(p.runOnce).toHaveBeenCalledExactlyOnceWith('mine');
});
it('stops before any recovery after shutdown',async()=>{
  const controller=new AbortController();controller.abort();const p=make({signal:controller.signal});
  await recoverPrivateMedia(p);expect(p.discover).not.toHaveBeenCalled();expect(p.runOnce).not.toHaveBeenCalled();
});
it('does not continue with another tenant after shutdown during a recovery',async()=>{
  const controller=new AbortController();const runOnce=vi.fn(async()=>{controller.abort();});
  const p=make({discover:vi.fn(async()=>['first','second']),runOnce,signal:controller.signal});
  await recoverPrivateMedia(p);expect(runOnce).toHaveBeenCalledExactlyOnceWith('first');
});
it('fails a one-shot recovery without exposing the underlying private error',async()=>{
  const p=make({runOnce:vi.fn(async()=>{throw Error('secret-canary');})});
  await expect(recoverPrivateMedia(p)).rejects.toThrow('PRIVATE_MEDIA_RECOVERY_FAILED');
});
it('isolates a tenant failure during watch and continues to the next tenant',async()=>{
  const p=make({discover:vi.fn(async()=>['bad','good']),runOnce:vi.fn().mockRejectedValueOnce(Error('secret')).mockResolvedValueOnce(undefined),onError:vi.fn()});
  await recoverPrivateMedia(p);expect(p.onError).toHaveBeenCalledExactlyOnceWith();
  expect(p.runOnce).toHaveBeenCalledTimes(2);expect(p.runOnce).toHaveBeenLastCalledWith('good');
});
