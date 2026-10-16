import {describe, expect, it, vi} from 'vitest';
import {createCentralCatalogMaintenance} from '../../src/commands/central-catalog-maintenance.js';

describe('central group maintenance outside message delivery',()=>{
  it('does not block delivery, does not overlap passes, and visits the next company after a slow provider',async()=>{
    let release!:()=>void;
    const pending=new Promise<void>(resolve=>{release=resolve;});
    const seen:string[]=[];
    const maintenance=createCentralCatalogMaintenance({
      loadPage:async()=>['company-a','company-b'],
      refresh:async org=>{seen.push(org);if(org==='company-a')await pending;},
      belongsToShard:()=>true,
      onError:vi.fn(),
    });
    maintenance.start();
    await Promise.resolve();await Promise.resolve();
    maintenance.start();
    const deliver=vi.fn(async()=>undefined);
    await deliver();
    expect(deliver).toHaveBeenCalledOnce();
    expect(seen).toEqual(['company-a']);
    release();await maintenance.finish();
    expect(seen).toEqual(['company-a','company-b']);
  });
  it('isolates failures, skips other shards and can start again after rejection',async()=>{
    const onError=vi.fn();
    const refresh=vi.fn(async(org:string)=>{if(org==='company-a')throw new Error('provider failed');});
    const maintenance=createCentralCatalogMaintenance({loadPage:async()=>['company-a','other-shard','company-b'],refresh,
      belongsToShard:org=>org!=='other-shard',onError});
    maintenance.start();await maintenance.finish();
    maintenance.start();await maintenance.finish();
    expect(refresh.mock.calls.map(([org])=>org)).toEqual(['company-a','company-b','company-a','company-b']);
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
