import { expect,it,vi } from 'vitest';
import type { LifecycleTransaction } from '../lifecycle/service.js';
import { createPrivateMediaCleanup } from './private-media-cleanup.js';
function fixture(pending:boolean,uncertain:boolean,configured=true,kind='CHANNEL',channel:string|null='channel') {
  const events:string[]=[];
  const query=vi.fn(async(sql:string)=>{
    if(sql.includes('FROM lifecycle_deletions'))return {rows:[{organization_id:'org',kind,messaging_channel_id:channel}],rowCount:1};
    events.push('inspect-ledger');return {rows:[{pending,uncertain}],rowCount:1};
  });
  const transact:LifecycleTransaction=async work=>work({query} as never);
  const store={prepareCleanup:vi.fn(async()=>{events.push('prepare');return 1;}),runCleanupOnce:vi.fn(async()=>{events.push('run-once');return true;})};
  return {run:createPrivateMediaCleanup(transact,configured?store:undefined),events,store,query};
}
it('requires exact ledger absence before declaring cleanup complete',async()=>{
  const f=fixture(false,false);
  expect(await f.run('deletion','lease')).toEqual({state:'COMPLETE'});
  expect(f.events).toEqual(['prepare','run-once','inspect-ledger']);
});
it('runs one bounded cleanup tick and yields when another prepared object remains',async()=>{
  const f=fixture(true,false);
  expect(await f.run('deletion','lease')).toEqual({state:'PENDING'});
  expect(f.store.runCleanupOnce).toHaveBeenCalledExactlyOnceWith('deletion','lease');
});
it('preserves uncertain objects rather than restarting their deletion',async()=>{
  const f=fixture(true,true);
  expect(await f.run('deletion','lease')).toEqual({state:'UNKNOWN'});
  expect(f.store.runCleanupOnce).toHaveBeenCalledOnce();
});
it('does not purge private history when the backend has been removed',async()=>{
  const f=fixture(true,false,false);
  expect(await f.run('deletion','lease')).toEqual({state:'UNKNOWN'});
  expect(f.store.prepareCleanup).not.toHaveBeenCalled();expect(f.store.runCleanupOnce).not.toHaveBeenCalled();
});
it('allows database-only history cleanup without a configured private backend',async()=>{
  const f=fixture(false,false,false);
  expect(await f.run('deletion','lease')).toEqual({state:'COMPLETE'});
  expect(f.store.runCleanupOnce).not.toHaveBeenCalled();expect(f.events).toEqual(['inspect-ledger']);
});
it('does not widen an instance-only CHANNEL deletion to other boxes in the company',async()=>{
  const f=fixture(true,true,true,'CHANNEL',null);
  expect(await f.run('deletion','lease')).toEqual({state:'COMPLETE'});
  expect(f.store.prepareCleanup).not.toHaveBeenCalled();
  expect(f.store.runCleanupOnce).not.toHaveBeenCalled();
  expect(f.events).toEqual([]);
});
it('does not let absent backend and another box affect an instance-only CHANNEL deletion',async()=>{
  const f=fixture(true,true,false,'CHANNEL',null);
  expect(await f.run('deletion','lease')).toEqual({state:'COMPLETE'});
  expect(f.events).toEqual([]);
});
