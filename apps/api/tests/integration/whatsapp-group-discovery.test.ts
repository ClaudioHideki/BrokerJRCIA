import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {ensureQrChannel} from '../../src/modules/messaging/qr-service.js';
import {createWhatsAppGroupCatalog} from '../../src/modules/whatsapp-groups/service.js';
import {createChatwootHealth} from '../../src/modules/integrations/chatwoot-health.js';

const key=Buffer.alloc(32,23).toString('base64'),phone='15550000001';
const groups=[1,2].map(n=>({groupJid:`12000000000000${n}@g.us`,subject:`Synthetic group ${n}`,participantCount:2,restrict:false,announce:false,isCommunity:false,isCommunityAnnounce:false,linkedParent:null}));
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();},180000);
afterAll(async()=>{await db?.dispose();});
async function fixture(){
 const tenant=await seedAttendanceTenant(db.database,false),integration=randomUUID();
 const channel=await db.transact(tenant.org,async tx=>{
  const provider=(await tx.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','Synthetic discovery') RETURNING id",[tenant.org])).rows[0].id;
  const instance=(await tx.query("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'Synthetic discovery',$3,'CONNECTED') RETURNING id",[tenant.org,provider,randomUUID()])).rows[0].id;
  return ensureQrChannel(tx,tenant.org,instance);
 });
 await db.database.pool.query("INSERT INTO chatwoot_destinations(organization_id,base_url,mode,approval_status) VALUES($1,$2,'MANAGED','APPROVED')",[tenant.org,`https://${tenant.org}.example.test`]);
 await db.database.pool.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,status) VALUES($1,$2,7,'READY')",[tenant.org,`https://${tenant.org}.example.test`]);
 await db.database.pool.query("INSERT INTO chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status) VALUES($1,$2,$3,9,'Synthetic discovery','READY')",[integration,tenant.org,channel.id]);
 const health=createChatwootHealth({encryptionKey:key,transact:db.transact,readIdentity:async()=>({connected:true,phone})});
 await db.transact(tenant.org,async tx=>{await health.enroll(tx,tenant.org,integration);await health.observe(tx,tenant.org,channel.id,{connected:true,phone});});
 await db.database.pool.query('UPDATE chatwoot_connection_health SET approved_fingerprint=observed_fingerprint WHERE organization_id=$1',[tenant.org]);
 const identity=vi.fn(async()=>({connected:true,phone})),readGroups=vi.fn(async()=>groups),configure=vi.fn();
 const service=createWhatsAppGroupCatalog({encryptionKey:key,transact:db.transact,readIdentity:identity,readGroups,ensureEventsConfiguration:configure});
 const effects=async()=>db.transact(tenant.org,async tx=>Object.fromEntries(await Promise.all(['messaging_messages','messaging_conversations','messaging_outbox','messaging_bot_jobs','automation_executions','whatsapp_group_automation_controls','integration_jobs','chatwoot_group_scopes'].map(async table=>[table,(await tx.query(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id=$1`,[tenant.org])).rows[0].n]))));
 const expire=()=>db.database.pool.query("UPDATE whatsapp_group_catalogs SET valid_until=clock_timestamp()-interval '1 minute',observed_at=clock_timestamp()-interval '6 minutes',last_attempt_at=clock_timestamp()-interval '1 minute' WHERE organization_id=$1 AND channel_id=$2",[tenant.org,channel.id]);
 return{...tenant,channel:channel.id,integration,identity,readGroups,configure,service,effects,expire};
}
it('bootstraps a canonical ready box with zero catalog/selection and no message or automation effects',async()=>{
 const f=await fixture(),before=await f.effects();
 expect(await f.service.refreshDueForCentral(f.org)).toMatchObject({processed:true,status:'CURRENT',channelId:f.channel});
 const page=await f.service.page({organizationId:f.org,actorId:(await db.database.pool.query('SELECT user_id FROM memberships WHERE organization_id=$1',[f.org])).rows[0].user_id},f.channel,{limit:50});
 expect(page.snapshot.status).toBe('CURRENT');expect(page.items).toHaveLength(2);expect(page.items.every(item=>!item.selected&&!item.automationEnabled)).toBe(true);
 expect(await f.effects()).toEqual(before);expect(f.configure).not.toHaveBeenCalled();expect(f.readGroups).toHaveBeenCalledOnce();
 expect(await f.service.refreshDueForCentral(f.org)).toEqual({processed:false});
 await f.expire();expect(await f.service.refreshDueForCentral(f.org)).toMatchObject({status:'CURRENT'});
 expect((await db.transact(f.org,tx=>tx.query('SELECT count(*)::int AS n FROM whatsapp_group_catalog_items WHERE organization_id=$1 AND selected',[f.org]))).rows[0].n).toBe(0);
 expect(await f.effects()).toEqual(before);
 const other=await seedAttendanceTenant(db.database,false);
 expect((await db.transact(other.org,tx=>tx.query('SELECT channel_id FROM whatsapp_group_catalogs WHERE organization_id=$1',[f.org]))).rows).toEqual([]);
});
it('preserves explicit selected and unselected choices when renewing without a bot',async()=>{
 const f=await fixture();await f.service.refreshDueForCentral(f.org);
 await db.database.pool.query('UPDATE whatsapp_group_catalog_items SET selected=true WHERE organization_id=$1 AND channel_id=$2 AND group_jid=$3',[f.org,f.channel,groups[0]!.groupJid]);
 await f.expire();expect(await f.service.refreshDueForCentral(f.org)).toMatchObject({status:'CURRENT'});
 expect((await db.transact(f.org,tx=>tx.query('SELECT selected FROM whatsapp_group_catalog_items WHERE organization_id=$1 AND channel_id=$2 ORDER BY group_jid',[f.org,f.channel]))).rows).toEqual([{selected:true},{selected:false}]);
});
it('retains a failed initial attempt and retries only after the existing cooldown',async()=>{
 const f=await fixture();f.readGroups.mockRejectedValueOnce(Object.assign(new Error('Synthetic timeout'),{code:'PROVIDER_TIMEOUT'}));
 expect(await f.service.refreshDueForCentral(f.org)).toMatchObject({status:'FAILED',code:'PROVIDER_TIMEOUT'});
 expect((await db.transact(f.org,tx=>tx.query('SELECT snapshot_id,lease_token,last_error_code FROM whatsapp_group_catalogs WHERE organization_id=$1 AND channel_id=$2',[f.org,f.channel]))).rows[0]).toEqual({snapshot_id:null,lease_token:null,last_error_code:'PROVIDER_TIMEOUT'});
 expect(await f.service.refreshDueForCentral(f.org)).toEqual({processed:false});expect(f.readGroups).toHaveBeenCalledOnce();
 await db.database.pool.query("UPDATE whatsapp_group_catalogs SET last_attempt_at=clock_timestamp()-interval '1 minute' WHERE organization_id=$1",[f.org]);
 expect(await f.service.refreshDueForCentral(f.org)).toMatchObject({status:'CURRENT'});
});
it('rejects discovery when the destination is revoked during provider I/O',async()=>{
 const f=await fixture();f.readGroups.mockImplementationOnce(async()=>{await db.database.pool.query("UPDATE chatwoot_destinations SET approval_status='REVOKED' WHERE organization_id=$1",[f.org]);return groups;});
 expect(await f.service.refreshDueForCentral(f.org)).toMatchObject({status:'FAILED',code:'GROUP_ACCESS_DENIED'});
 expect((await db.transact(f.org,tx=>tx.query('SELECT snapshot_id FROM whatsapp_group_catalogs WHERE organization_id=$1',[f.org]))).rows[0].snapshot_id).toBeNull();
});
it('does not discover while an enforced identity has not been approved',async()=>{
 const f=await fixture();await db.database.pool.query('UPDATE chatwoot_connection_health SET approved_fingerprint=NULL WHERE organization_id=$1',[f.org]);
 expect(await f.service.refreshDueForCentral(f.org)).toEqual({processed:false});expect(f.readGroups).not.toHaveBeenCalled();
});
