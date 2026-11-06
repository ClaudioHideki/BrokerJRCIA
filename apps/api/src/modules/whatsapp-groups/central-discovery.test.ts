import {expect,it,vi} from 'vitest';
vi.mock('../tenancy/operational-limits.js',()=>({requireActiveOrganization:vi.fn(),TenantOperationalError:class extends Error{}}));
vi.mock('../attendance/repository.js',()=>({lockAttendanceChannel:vi.fn()}));
vi.mock('./events.js',()=>({reconcileWhatsAppGroupParticipation:vi.fn()}));
import {createWhatsAppGroupCatalog} from './service.js';

const org='11111111-1111-4111-8111-111111111111',channel='22222222-2222-4222-8222-222222222222';
const item={groupJid:'120000000000001@g.us',subject:'Synthetic group',participantCount:2,restrict:false,announce:false,isCommunity:false,isCommunityAnnounce:false,linkedParent:null};
function fixture(binding?:{captureBinding:any;assertBinding:any}){
 const state={exists:false,allowed:true,busy:false,recent:false,elapsedSeconds:Infinity,forceDue:false,selected:false,published:false};
 const catalog:any={identity_revision:'1',identity_fingerprint:null,catalog_revision:'0',snapshot_id:null,observed_at:null,valid_until:null,last_attempt_at:new Date(),last_error_code:null,lease_token:null};
 let items:any[]=[];
 const query=vi.fn(async(sql:string,args:unknown[]=[])=>{
  const rows=(values:any[])=>({rows:values,rowCount:values.length});
  const cooldown=sql.includes("interval '5 minutes'")&&String(catalog.last_error_code).startsWith('PROVIDER_')?300:30;
  const cooling=state.recent||state.elapsedSeconds<=cooldown;
  if(sql.includes('GROUP_CENTRAL_CATALOG_DUE')){
   // The absent-catalog and unselected cases model the two SQL admission gaps.
   if(!state.allowed||state.busy||(!state.forceDue&&cooling)||(!state.exists&&!sql.includes('LEFT JOIN whatsapp_group_catalogs'))||(!state.selected&&sql.includes('item.selected')))return rows([]);
   return rows([{channel_id:channel}]);
  }
  if(sql.includes('GROUP_CENTRAL_CATALOG_ACCESS'))return rows(state.allowed&&(!sql.includes('item.selected')||state.selected)?[{allowed:1}]:[]);
  if(sql.includes('lock_local_attendance_member'))return rows([{role:'OWNER'}]);
  if(sql.includes('SELECT c.instance_id'))return rows([{instance_id:channel,upstream_instance_key:'synthetic-instance',connected:true}]);
  if(sql.startsWith('INSERT INTO whatsapp_group_catalogs')){const created=!state.exists;state.exists=true;if(created)state.recent=true;return rows(created?[{channel_id:channel}]:[]);}
  if(sql.includes('SELECT * FROM whatsapp_group_catalogs'))return rows(state.exists?[catalog]:[]);
  if(sql.includes('SET lease_token=$3')){
   if(state.busy||(sql.includes('last_attempt_at<')&&cooling&&args[3]!==true))return rows([]);
   state.busy=true;state.recent=true;return rows([{channel_id:channel}]);
  }
  if(sql.includes('SET snapshot_id=')){
   state.published=true;state.busy=false;
   Object.assign(catalog,{snapshot_id:args[3],identity_fingerprint:args[4],catalog_revision:'1',observed_at:new Date(),valid_until:new Date(Date.now()+300000),lease_token:null,last_error_code:null});
   return rows([{channel_id:channel}]);
  }
  if(sql.includes('last_error_code=$4')){state.busy=false;catalog.last_error_code=args[3];return rows([]);}
  if(sql.includes('SELECT group_jid'))return rows(items.filter(i=>i.selected).map(i=>({group_jid:i.groupJid})));
  if(sql.startsWith('INSERT INTO whatsapp_group_catalog_items')){items=JSON.parse(String(args[2]));return rows([]);}
  if(sql.includes('group_jid AS "groupJid"'))return rows(items.map(i=>({...i,automationEnabled:false})));
  if(sql.includes('SELECT count(*)'))return rows([{count:String(items.length)}]);
  return rows([]);
 });
 const identity=vi.fn(async()=>({connected:true,phone:'15550000001'})),groups=vi.fn(async()=>[item]),configure=vi.fn();
 const service=createWhatsAppGroupCatalog({encryptionKey:Buffer.alloc(32,21).toString('base64'),transact:async(_org,work)=>work({query} as any),readIdentity:identity,readGroups:groups,ensureEventsConfiguration:configure,...binding});
 return{state,catalog,query,identity,groups,configure,service};
}
it('discovers a ready central channel with no catalog or selection, immediately and read only',async()=>{
 const f=fixture();expect(await f.service.refreshDueForCentral(org)).toMatchObject({processed:true,status:'CURRENT',channelId:channel});
 expect(f.identity).toHaveBeenCalledTimes(2);expect(f.groups).toHaveBeenCalledOnce();expect(f.configure).not.toHaveBeenCalled();
 expect(f.query.mock.calls.find(([sql])=>sql.startsWith('INSERT INTO whatsapp_group_catalog_items'))?.[1]?.[2]).toContain('"selected":false');
 expect(f.query.mock.calls.some(([sql])=>/(?:INSERT INTO|UPDATE) (?:whatsapp_group_automation_controls|messaging_outbox|integration_jobs)|SET bot_public_id\s*=/u.test(sql))).toBe(false);
 expect(f.query.mock.calls.filter(([sql])=>sql.includes('GROUP_CENTRAL_CATALOG_')).every(([,args])=>args?.[0]===org)).toBe(true);
});
it('releases the initial lease on provider failure and preserves the retry cooldown',async()=>{
 const f=fixture();f.groups.mockRejectedValueOnce(new Error('Synthetic provider failure'));
 expect(await f.service.refreshDueForCentral(org)).toMatchObject({processed:true,status:'FAILED',code:'PROVIDER_REQUEST_FAILED'});
 expect(f.state.busy).toBe(false);expect(f.state.published).toBe(false);
 expect(await f.service.refreshDueForCentral(org)).toEqual({processed:false});expect(f.groups).toHaveBeenCalledOnce();
 f.state.recent=false;expect(await f.service.refreshDueForCentral(org)).toMatchObject({status:'CURRENT'});
});
it.each(['PROVIDER_REQUEST_FAILED','PROVIDER_TIMEOUT','PROVIDER_ABORTED','PROVIDER_INVALID_RESPONSE'])('waits five minutes after durable %s before a central retry',async code=>{
 const f=fixture();f.groups.mockRejectedValueOnce(Object.assign(new Error('Synthetic provider failure'),{code}));
 expect(await f.service.refreshDueForCentral(org)).toMatchObject({status:'FAILED',code});
 f.state.recent=false;
 for(const elapsed of [31,299,300]){
  f.state.elapsedSeconds=elapsed;expect(await f.service.refreshDueForCentral(org)).toEqual({processed:false});
 }
 expect(f.groups).toHaveBeenCalledOnce();expect(f.catalog.last_error_code).toBe(code);expect(f.state.busy).toBe(false);
 f.state.elapsedSeconds=301;expect(await f.service.refreshDueForCentral(org)).toMatchObject({status:'CURRENT'});
 expect(f.catalog.last_error_code).toBeNull();expect(f.groups).toHaveBeenCalledTimes(2);
 expect(f.query.mock.calls.findLast(([sql])=>sql.startsWith('INSERT INTO whatsapp_group_catalog_items'))?.[1]?.[2]).toContain('"selected":false');
});
it('rechecks provider cooldown when a candidate selected by an older due read reaches the claim',async()=>{
 const f=fixture();f.groups.mockRejectedValueOnce(Object.assign(new Error('Synthetic timeout'),{code:'PROVIDER_TIMEOUT'}));
 await f.service.refreshDueForCentral(org);f.state.recent=false;f.state.elapsedSeconds=31;f.state.forceDue=true;
 expect(await f.service.refreshDueForCentral(org)).toMatchObject({status:'FAILED',code:'GROUP_CATALOG_REFRESHING'});
 expect(f.groups).toHaveBeenCalledOnce();expect(f.catalog.last_error_code).toBe('PROVIDER_TIMEOUT');
});
it.each([null,'LEASE_LOST'])('keeps the ordinary thirty second admission interval with %s',async error=>{
 const f=fixture();f.state.exists=true;f.catalog.last_error_code=error;f.state.elapsedSeconds=30;
 expect(await f.service.refreshDueForCentral(org)).toEqual({processed:false});
 f.state.elapsedSeconds=31;expect(await f.service.refreshDueForCentral(org)).toMatchObject({status:'CURRENT'});
});
it('keeps explicit owner refresh available without applying the central worker backoff',async()=>{
 const f=fixture();f.groups.mockRejectedValueOnce(Object.assign(new Error('Synthetic timeout'),{code:'PROVIDER_TIMEOUT'}));
 await f.service.refreshDueForCentral(org);
 expect((await f.service.refresh({organizationId:org,actorId:'33333333-3333-4333-8333-333333333333'},channel)).snapshot.status).toBe('CURRENT');
 expect(f.configure).toHaveBeenCalledOnce();expect(f.groups).toHaveBeenCalledTimes(2);
 expect(f.query.mock.calls.findLast(([sql])=>sql.includes('SET lease_token=$3'))?.[0]).not.toContain("interval '5 minutes'");
});
it('does not publish a discovery after central authority is revoked during provider I/O',async()=>{
 const f=fixture();f.groups.mockImplementationOnce(async()=>{f.state.allowed=false;return[item];});
 expect(await f.service.refreshDueForCentral(org)).toMatchObject({processed:true,status:'FAILED',code:'GROUP_ACCESS_DENIED'});expect(f.state.published).toBe(false);
});
it('does not publish a catalog when the observed number changes during discovery',async()=>{
 const f=fixture();f.identity.mockResolvedValueOnce({connected:true,phone:'15550000001'}).mockResolvedValueOnce({connected:true,phone:'15550000002'});
 expect(await f.service.refreshDueForCentral(org)).toMatchObject({processed:true,status:'FAILED',code:'GROUP_IDENTITY_CHANGED'});expect(f.state.published).toBe(false);
});
it('does not publish a discovery when the captured engine binding no longer matches',async()=>{
 const captureBinding=vi.fn(async()=>({generation:1})),assertBinding=vi.fn(async()=>{throw new Error('Synthetic binding changed');});
 const f=fixture({captureBinding,assertBinding});
 expect(await f.service.refreshDueForCentral(org)).toMatchObject({status:'FAILED'});
 expect(captureBinding).toHaveBeenCalledOnce();expect(assertBinding).toHaveBeenCalledOnce();expect(f.state.published).toBe(false);
});
it.each(['busy','recent'] as const)('does not contact the provider when the catalog is %s',async field=>{
 const f=fixture();f.state.exists=true;f.state[field]=true;expect(await f.service.refreshDueForCentral(org)).toEqual({processed:false});expect(f.groups).not.toHaveBeenCalled();
});
