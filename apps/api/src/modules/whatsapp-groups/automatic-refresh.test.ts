import {createHmac} from 'node:crypto';
import {expect,it,vi} from 'vitest';
vi.mock('../tenancy/operational-limits.js',()=>({requireActiveOrganization:vi.fn(),TenantOperationalError:class extends Error{}}));
vi.mock('../attendance/repository.js',()=>({lockAttendanceChannel:vi.fn()}));
vi.mock('./events.js',()=>({reconcileWhatsAppGroupParticipation:vi.fn()}));
import {createWhatsAppGroupCatalog} from './service.js';
const org='11111111-1111-4111-8111-111111111111',channel='22222222-2222-4222-8222-222222222222',actor='33333333-3333-4333-8333-333333333333',phone='15550000001',key=Buffer.alloc(32,21),group='120000000000001@g.us';
function fixture(){
 const state={due:true,allowed:true,published:false,expired:false},queries:string[]=[];
 const fingerprint=createHmac('sha256',key).update(`whatsapp-group-identity:v1:${org}:${channel}:${phone}`).digest('hex');
 const catalog={identity_revision:'1',identity_fingerprint:fingerprint,catalog_revision:'1',snapshot_id:'44444444-4444-4444-8444-444444444444',observed_at:new Date(),valid_until:new Date(Date.now()-1000),last_attempt_at:new Date(),last_error_code:null,lease_token:null};
 const item={groupJid:group,subject:'Synthetic group',participantCount:2,restrict:false,announce:false,isCommunity:false,isCommunityAnnounce:false,linkedParent:null,selected:true,automationEnabled:true};
 const query=vi.fn(async(sql:string,parameters:unknown[]=[])=>{queries.push(sql);
  if(sql.includes('GROUP_AUTOMATION_CATALOG_DUE'))return{rows:state.due?[{channel_id:channel}]:[],rowCount:state.due?1:0};
  if(sql.includes('GROUP_AUTOMATION_CATALOG_ACCESS'))return{rows:state.allowed?[{allowed:1}]:[],rowCount:state.allowed?1:0};
  if(sql.includes('lock_local_attendance_member'))return{rows:[],rowCount:0};
  if(sql.includes('SELECT c.instance_id'))return{rows:[{instance_id:channel,upstream_instance_key:'synthetic-instance',connected:true}],rowCount:1};
  if(sql.includes('SELECT * FROM whatsapp_group_catalogs'))return{rows:[catalog],rowCount:1};
  if(sql.includes('SET snapshot_id=')){if(state.expired&&parameters[5] instanceof Date)return{rows:[],rowCount:0};state.published=true;catalog.valid_until=new Date(Date.now()+300000);return{rows:[{channel_id:channel}],rowCount:1};}
  if(sql.includes('group_jid AS "groupJid"'))return{rows:[item],rowCount:1};
  if(sql.includes('SELECT count(*)'))return{rows:[{count:'1'}],rowCount:1};
  if(sql.includes('SELECT group_jid'))return{rows:[{group_jid:group}],rowCount:1};
  return{rows:[{channel_id:channel}],rowCount:1};
 });
 const identity=vi.fn(async()=>({connected:true,phone})),groups=vi.fn(async()=>[item]),configure=vi.fn(async()=>undefined);
 const service=createWhatsAppGroupCatalog({encryptionKey:key.toString('base64'),transact:async(_org,work)=>work({query} as any),readIdentity:identity,readGroups:groups,ensureEventsConfiguration:configure}) as ReturnType<typeof createWhatsAppGroupCatalog>&{refreshDueForAutomation(org:string):Promise<{processed:boolean;status?:string}>};
 return{service,state,queries,identity,groups,configure};
}
it('renews an opted-in expiring catalog without changing human controls or writing provider configuration',async()=>{
 const f=fixture();expect(await f.service.refreshDueForAutomation(org)).toMatchObject({processed:true,status:'CURRENT'});
 expect(f.state.published).toBe(true);expect(f.identity).toHaveBeenCalledTimes(2);expect(f.groups).toHaveBeenCalledOnce();expect(f.configure).not.toHaveBeenCalled();
 expect(f.queries.some(sql=>sql.includes('lock_local_attendance_member'))).toBe(false);
 expect(f.queries.some(sql=>/UPDATE whatsapp_group_automation_controls/u.test(sql))).toBe(false);
});
it('does not refresh unused or already fresh catalogs',async()=>{
 const f=fixture();f.state.due=false;expect(await f.service.refreshDueForAutomation(org)).toEqual({processed:false});expect(f.identity).not.toHaveBeenCalled();expect(f.groups).not.toHaveBeenCalled();
});
it('rechecks the configured bot authority after provider I/O before publishing refreshed facts',async()=>{
 const f=fixture();f.groups.mockImplementation(async()=>{f.state.allowed=false;return[];});
 expect(await f.service.refreshDueForAutomation(org)).toMatchObject({processed:true,status:'FAILED'});expect(f.state.published).toBe(false);
 expect(f.queries.some(sql=>sql.includes('last_error_code=$4'))).toBe(true);expect(f.configure).not.toHaveBeenCalled();
});
it('does not treat an HTTP-shaped worker flag as system authority',async()=>{
 const f=fixture();await expect(f.service.refresh({organizationId:org,actorId:actor,worker:true} as any,channel)).rejects.toThrow('GROUP_ACCESS_DENIED');expect(f.groups).not.toHaveBeenCalled();expect(f.state.published).toBe(false);
});
it('does not publish a provider result whose SQL-clock request deadline expired while waiting for locks',async()=>{
 const f=fixture();f.groups.mockImplementation(async()=>{f.state.expired=true;return[];});
 expect(await f.service.refreshDueForAutomation(org)).toMatchObject({processed:true,status:'FAILED',code:'GROUP_REFRESH_LEASE_LOST'});
 expect(f.state.published).toBe(false);expect(f.configure).not.toHaveBeenCalled();
});
