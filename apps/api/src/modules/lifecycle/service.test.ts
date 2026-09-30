import { describe, expect, it, vi } from 'vitest';
import { createLifecycleService, LifecycleError, withLifecyclePlatformTransaction, type LifecycleTransaction } from './service.js';

describe('lifecycle deletion orchestration', () => {
  it('uses the exact company name and authenticated global actor for the durable request', async () => {
    const query=vi.fn().mockResolvedValueOnce({rows:[{id:'operation-1'}]})
      .mockResolvedValueOnce({rows:[{status:'REQUESTED'}]});
    const transact:LifecycleTransaction=async work=>work({query} as never);
    const service=createLifecycleService({transact,deprovision:vi.fn()});
    await expect(service.requestOrganization('org-1','Casa do Construtor','Pedido explícito','actor-1')).resolves.toEqual({operationId:'operation-1',status:'REQUESTED'});
    expect(query).toHaveBeenCalledWith('SELECT public.lifecycle_request_organization($1,$2,$3,$4) AS id',
      ['org-1','Casa do Construtor','Pedido explícito','actor-1']);
  });

  it('preserves ACTION_REQUIRED when Evolution does not verify removal', async () => {
    const query=vi.fn().mockImplementation(async (sql:string)=>{
      if(sql.includes('UPDATE lifecycle_deletions SET status=\'CLEANING_EXTERNAL\'')) return {rows:[{id:'operation-1',organization_id:'org-1',kind:'CHANNEL',resource_id:'channel-1',lease_token:'lease-1'}]};
      if(sql.includes('AS authorized'))return {rows:[{authorized:true}]};
      if(sql.includes('FROM lifecycle_cleanup_items WHERE deletion_id=')) return {rows:[{instance_id:'instance-1',upstream_key:'qr-1',status:'PENDING'}]};
      return {rows:[],rowCount:1};
    });
    const transact:LifecycleTransaction=async work=>work({query} as never);
    const deprovision=vi.fn().mockRejectedValue(new Error('private upstream detail'));
    const service=createLifecycleService({transact,deprovision,uuid:()=> 'lease-1'});
    await service.processOne();
    expect(query.mock.calls.some(([sql])=>String(sql).includes("status='ACTION_REQUIRED'"))).toBe(true);
    expect(query.mock.calls.some(([sql])=>String(sql).includes('lifecycle_purge_channel'))).toBe(false);
    expect(query.mock.calls.flat().join(' ')).not.toContain('private upstream detail');
  });

  it('does not touch the provider when the original actor lost permission',async()=>{
    const query=vi.fn().mockImplementation(async(sql:string)=>{
      if(sql.includes("status='CLEANING_EXTERNAL'"))return {rows:[{id:'operation-1',organization_id:'org-1',kind:'CHANNEL',resource_id:'channel-1',lease_token:'lease-1'}]};
      if(sql.includes('AS authorized'))return {rows:[{authorized:false}]};
      return {rows:[],rowCount:1};
    });
    const deprovision=vi.fn(),transact:LifecycleTransaction=async work=>work({query} as never);
    const service=createLifecycleService({transact,deprovision,uuid:()=> 'lease-1'});
    expect(await service.processOne()).toBe(true);
    expect(deprovision).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql])=>String(sql).includes("error_code='LIFECYCLE_ACTOR_REVOKED'"))).toBe(true);
  });

  it('rechecks the actor before each external instance removal',async()=>{
    let checks=0;
    const query=vi.fn().mockImplementation(async(sql:string)=>{
      if(sql.includes("status='CLEANING_EXTERNAL'"))return {rows:[{id:'operation-1',organization_id:'org-1',kind:'ORGANIZATION',resource_id:'org-1',lease_token:'lease-1'}]};
      if(sql.includes('AS authorized'))return {rows:[{authorized:++checks<4}]};
      if(sql.includes('FROM lifecycle_cleanup_items WHERE deletion_id='))return {rows:[
        {instance_id:'instance-1',upstream_key:'qr-1',status:'PENDING'},
        {instance_id:'instance-2',upstream_key:'qr-2',status:'PENDING'},
      ]};
      return {rows:[],rowCount:1};
    });
    const deprovision=vi.fn(),transact:LifecycleTransaction=async work=>work({query} as never);
    const service=createLifecycleService({transact,deprovision,uuid:()=> 'lease-1'});
    expect(await service.processOne()).toBe(true);
    expect(deprovision).toHaveBeenCalledExactlyOnceWith('org-1','qr-1');
    expect(query.mock.calls.some(([sql])=>String(sql).includes("error_code='LIFECYCLE_ACTOR_REVOKED'"))).toBe(true);
    expect(query.mock.calls.some(([sql])=>String(sql).includes('lifecycle_purge_organization'))).toBe(false);
  });

  it('maps a missing or wrong-name resource without leaking internal SQL', () => {
    const service=createLifecycleService({transact:vi.fn() as unknown as LifecycleTransaction,deprovision:vi.fn()});
    expect(service.translateError({code:'P0002'})).toEqual(new LifecycleError('LIFECYCLE_RESOURCE_NOT_FOUND',404));
  });

  it('reads the persisted state on an idempotent retry rather than claiming REQUESTED',async()=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[{id:'operation-2'}]})
      .mockResolvedValueOnce({rows:[{status:'COMPLETED'}]});
    const transact:LifecycleTransaction=async work=>work({query} as never);
    const service=createLifecycleService({transact,deprovision:vi.fn()});
    await expect(service.requestChannel('org','channel','QR','Authorized cleanup','TENANT','actor'))
      .resolves.toEqual({operationId:'operation-2',status:'COMPLETED'});
  });

  it('discards a pooled connection when rollback itself fails',async()=>{
    const rollbackError=new Error('rollback failed'),release=vi.fn();
    const query=vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({rows:[{
      currentUser:'jrc_platform',sessionUser:'jrc_platform',rolsuper:false,rolbypassrls:false,
    }]}).mockRejectedValueOnce(rollbackError);
    const pool={connect:vi.fn().mockResolvedValue({query,release})} as never;
    await expect(withLifecyclePlatformTransaction(pool,async()=>{throw new Error('operation failed');}))
      .rejects.toBeInstanceOf(AggregateError);
    expect(release).toHaveBeenCalledWith(rollbackError);
  });
});
