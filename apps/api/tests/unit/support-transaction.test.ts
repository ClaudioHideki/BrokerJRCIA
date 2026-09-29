import {expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {withSupportPlatformTransaction} from '../../src/modules/support/service.js';

it('discards a staff connection when rollback fails rather than returning it to the pool',async()=>{
  const rollback=new Error('synthetic rollback failure');
  const client={query:vi.fn(async(sql:string)=>{
    if(sql==='ROLLBACK')throw rollback;
    return {rows:[{current_user:'jrc_platform',session_user:'jrc_platform',rolsuper:false,rolbypassrls:false}]};
  }),release:vi.fn()};
  const pool={connect:async()=>client} as unknown as Pool;
  await expect(withSupportPlatformTransaction(pool,async()=>{throw new Error('synthetic operation failure');})).rejects.toBeInstanceOf(AggregateError);
  expect(client.release).toHaveBeenCalledWith(rollback);
});
