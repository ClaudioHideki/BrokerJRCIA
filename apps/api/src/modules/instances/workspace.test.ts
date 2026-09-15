import {expect,it,vi} from 'vitest';
import type {TenantTransaction} from '../../db/tenant-transaction.js';
import {InstanceWorkspaceService} from './workspace.js';
const org='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
const settings={rejectCall:false,msgCall:'',groupsIgnore:false,alwaysOnline:false,readMessages:false,readStatus:false,syncFullHistory:false};
function fixture(){
 let active=true;const audit:unknown[][]=[];
 const provider={read:vi.fn(async()=>({profile:{name:'Demo',phone:null,state:'open'},counts:{contacts:4,chats:2,messages:6},settings})),updateSettings:vi.fn(async()=>undefined)};
 const transact=async<T>(tenant:string,operation:(tx:TenantTransaction)=>Promise<T>):Promise<T>=>operation({query:async(sql:string,args:unknown[])=>{
  if(sql.includes('FROM instances'))return {rows:tenant===org&&args[0]===org&&args[1]===id?[{id,name:'Demo',status:'CONNECTED',provider:'BAILEYS',upstreamKey:'jrc_demo',organizationStatus:active?'ACTIVE':'SUSPENDED',createdAt:new Date(0),updatedAt:new Date(0)}]:[]};
  if(sql.includes('FROM memberships'))return {rows:[{role:'OWNER'}]};
  if(sql.includes('INSERT INTO audit_logs'))audit.push(args);
  return {rows:[]};
 }} as unknown as TenantTransaction);
 return {service:new InstanceWorkspaceService({transact,provider}),provider,audit,suspend(){active=false;}};
}
const actor={organizationId:org,actorId:'44444444-4444-4444-8444-444444444444',role:'OWNER' as const,requestId:'55555555-5555-4555-8555-555555555555'};
it('rejects a foreign organization before accessing the provider',async()=>{
 const f=fixture();await expect(f.service.read({...actor,organizationId:other},id)).rejects.toMatchObject({status:404});
 expect(f.provider.read).not.toHaveBeenCalled();
});
it('returns unknown counters when the provider is unavailable, not fabricated zeroes',async()=>{
 const f=fixture();f.provider.read.mockRejectedValue(new Error('private-provider-token'));
 const result=await f.service.read(actor,id);expect(result.providerAvailable).toBe(false);expect(result.counts.contacts).toBeNull();expect(JSON.stringify(result)).not.toContain('private-provider-token');
});
it('blocks viewer and suspended mutations and audits allowed updates',async()=>{
 const f=fixture();await expect(f.service.update({...actor,role:'VIEWER'},id,settings)).rejects.toMatchObject({status:403});
 await f.service.update(actor,id,settings);expect(f.provider.updateSettings).toHaveBeenCalledTimes(1);expect(f.audit).toHaveLength(2);
 f.suspend();await expect(f.service.update(actor,id,settings)).rejects.toMatchObject({status:403});expect(f.provider.updateSettings).toHaveBeenCalledTimes(1);
});
