import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { createLifecycleService, withLifecyclePlatformTransaction, withLifecycleWorkerTransaction } from '../../src/modules/lifecycle/service.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { connectionStringForRole } from './helpers/task7.js';

describe('permanent tenant and channel deletion with PostgreSQL ownership boundaries',()=>{
  let db:IsolatedPostgresDatabase, platform:Pool, worker:Pool, app:Pool;
  const actor=randomUUID(), a=randomUUID(), b=randomUUID(), c=randomUUID();
  const ownerA=randomUUID(), ownerB=randomUUID(), ownerC=randomUUID(), shared=randomUUID();
  const accountA=randomUUID(), accountB=randomUUID(), accountC=randomUUID();
  const instanceA=randomUUID(), instanceB=randomUUID(), instanceC=randomUUID();
  const deprovision=vi.fn(async()=>undefined);
  let service:ReturnType<typeof createLifecycleService>,workerService:ReturnType<typeof createLifecycleService>;
  beforeAll(async()=>{
    const adminUrl=requireTestDatabaseAdminUrl();db=await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl,()=>runMigrations(db.connectionString));
    const seed=await db.pool.connect();
    try{
    await seed.query('BEGIN');
    await seed.query(`INSERT INTO platform_users(id,email,password_hash,role,mfa_seed)
      VALUES($1,'lifecycle-admin@example.test','no-login','SUPER_ADMIN','no-login')`,[actor]);
    for(const [org,name,owner,account,instance] of [
      [a,'Lifecycle A',ownerA,accountA,instanceA],
      [b,'Lifecycle B',ownerB,accountB,instanceB],
      [c,'Lifecycle C',ownerC,accountC,instanceC],
    ] as const){
      await seed.query('INSERT INTO organizations(id,name,slug) VALUES($1,$2,$3)',[org,name,org]);
      await seed.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[owner,`${owner}@example.test`,'no-login']);
      await seed.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')",[org,owner]);
      await seed.query("INSERT INTO provider_accounts(id,organization_id,provider,name) VALUES($1,$2,'BAILEYS','QR')",[account,org]);
      await seed.query("INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,$3,$4,$5,'DISCONNECTED')",
        [instance,org,account,`WhatsApp ${name}`,`qa-${instance}`]);
    }
    await seed.query("INSERT INTO users(id,email,password_hash) VALUES($1,'shared@example.test','no-login')",[shared]);
    await seed.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$3,'OPERATOR'),($2,$3,'OPERATOR')",[b,c,shared]);
    await seed.query('COMMIT');
    }catch(error){await seed.query('ROLLBACK');throw error;}finally{seed.release();}
    const url=new URL(db.connectionString);url.username='jrc_platform';url.password='';
    platform=new Pool({connectionString:url.toString()});
    url.username='jrc_lifecycle';worker=new Pool({connectionString:url.toString()});
    app=new Pool({connectionString:connectionStringForRole(db.connectionString,'jrc_app')});
    service=createLifecycleService({transact:work=>withLifecyclePlatformTransaction(platform,work),deprovision});
    workerService=createLifecycleService({transact:work=>withLifecycleWorkerTransaction(worker,work),deprovision});
  },60_000);
  afterAll(async()=>{await app?.end();await platform?.end();await worker?.end();await db?.dispose();});

  it('requires a real current actor and exact name; app and platform roles cannot forge purge',async()=>{
    const preview=await service.previewChannel(a,instanceA);
    expect(preview).toMatchObject({resourceName:'WhatsApp Lifecycle A',kind:'CHANNEL',canDelete:true});
    await expect(service.requestChannel(a,instanceA,'Wrong name','Authorized cleanup','TENANT',ownerA))
      .rejects.toMatchObject({status:404});
    await expect(service.requestChannel(a,instanceA,'WhatsApp Lifecycle A','Authorized cleanup','TENANT',ownerB))
      .rejects.toMatchObject({status:403});
    await expect(app.query('SELECT id FROM lifecycle_deletions')).rejects.toMatchObject({code:'42501'});
    expect((await db.pool.query("SELECT has_table_privilege('jrc_app','lifecycle_deletions','DELETE') AS allowed")).rows[0].allowed).toBe(false);
    await expect(platform.query("UPDATE lifecycle_deletions SET status='COMPLETED'")).rejects.toMatchObject({code:'42501'});
    await expect(platform.query('SELECT public.lifecycle_purge_channel($1,$2)',[randomUUID(),randomUUID()]))
      .rejects.toMatchObject({code:'42501'});
  });

  it('removes only the chosen QR connection after verified Evolution cleanup',async()=>{
    const requested=await service.requestChannel(a,instanceA,'WhatsApp Lifecycle A','Authorized cleanup','TENANT',ownerA);
    expect(requested.status).toBe('REQUESTED');
    expect(await workerService.processOne()).toBe(true);
    expect(await service.status(a,instanceA,requested.operationId)).toMatchObject({status:'COMPLETED',errorCode:null});
    expect(deprovision).toHaveBeenCalledWith(a,`qa-${instanceA}`);
    expect((await db.pool.query('SELECT count(*)::int n FROM instances WHERE organization_id=$1',[a])).rows[0].n).toBe(0);
    expect((await db.pool.query('SELECT count(*)::int n FROM instances WHERE organization_id=$1',[b])).rows[0].n).toBe(1);
    expect((await db.pool.query('SELECT count(*)::int n FROM organizations WHERE id=$1',[a])).rows[0].n).toBe(1);
  });

  it('cancels safe, unclaimed accepted sends; a claimed or uncertain send blocks deletion',async()=>{
    const channel=randomUUID(),contact=randomUUID(),conversation=randomUUID(),safe=randomUUID(),media=randomUUID();
    await db.pool.query("INSERT INTO messaging_channels(id,organization_id,provider_account_id,provider,instance_id,credential_reference) VALUES($1,$2,$3,'BAILEYS',$4,'qa')",
      [channel,b,accountB,instanceB]);
    await db.pool.query('INSERT INTO messaging_contacts(id,organization_id,external_id) VALUES($1,$2,$3)',[contact,b,'contact-b']);
    await db.pool.query('INSERT INTO messaging_conversations(id,organization_id,channel_id,contact_id) VALUES($1,$2,$3,$4)',
      [conversation,b,channel,contact]);
    await db.pool.query('INSERT INTO attendance_owners(organization_id,channel_id) VALUES($1,$2)',[b,channel]);
    await db.pool.query("INSERT INTO attendance_sessions(organization_id,channel_id,conversation_id,cycle,state,owner_revision) VALUES($1,$2,$3,1,'RESOLVED',0)",[b,channel,conversation]);
    await db.pool.query("INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state) VALUES($1,$2,$3,$4,'OUTGOING','OPERATOR',$5,'ACCEPTED')",
      [safe,b,channel,conversation,JSON.stringify({type:'TEXT',text:'safe'})]);
    await db.pool.query('INSERT INTO messaging_outbox(organization_id,message_id) VALUES($1,$2)',[b,safe]);
    await db.pool.query("INSERT INTO messaging_media(id,organization_id,channel_id,source,source_key,kind,file_name,descriptor) VALUES($1,$2,$3,'QR','media-b','image','file.png','{}')",
      [media,b,channel]);
    await db.pool.query("INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state) VALUES($1,$2,$3,$4,'OUTGOING','OPERATOR',$5,'SENT')",
      [randomUUID(),b,channel,conversation,JSON.stringify({type:'MEDIA',mediaId:media,kind:'image',fileName:'file.png'})]);
    const request=await service.requestChannel(b,instanceB,'WhatsApp Lifecycle B','Authorized cleanup','TENANT',ownerB);
    expect((await db.pool.query('SELECT state FROM messaging_messages WHERE id=$1',[safe])).rows[0].state).toBe('FAILED');
    expect((await db.pool.query('SELECT count(*)::int n FROM messaging_outbox WHERE message_id=$1',[safe])).rows[0].n).toBe(0);
    expect(await workerService.processOne()).toBe(true);
    expect((await service.status(b,instanceB,request.operationId)).status).toBe('COMPLETED');
    expect((await db.pool.query('SELECT count(*)::int n FROM messaging_messages WHERE id=$1',[safe])).rows[0].n).toBe(0);
    expect((await db.pool.query('SELECT count(*)::int n FROM messaging_media WHERE id=$1',[media])).rows[0].n).toBe(0);
    expect((await db.pool.query('SELECT * FROM attendance_owners WHERE organization_id=$1',[b])).rows).toEqual([]);
    expect((await db.pool.query('SELECT * FROM attendance_sessions WHERE organization_id=$1',[b])).rows).toEqual([]);
    const uncertainChannel=randomUUID(),uncertain=randomUUID(),contactC=randomUUID(),conversationC=randomUUID();
    await db.pool.query("INSERT INTO messaging_channels(id,organization_id,provider_account_id,provider,instance_id,credential_reference) VALUES($1,$2,$3,'BAILEYS',$4,'qa')",
      [uncertainChannel,c,accountC,instanceC]);
    await db.pool.query('INSERT INTO messaging_contacts(id,organization_id,external_id) VALUES($1,$2,$3)',[contactC,c,'contact-c']);
    await db.pool.query('INSERT INTO messaging_conversations(id,organization_id,channel_id,contact_id) VALUES($1,$2,$3,$4)',
      [conversationC,c,uncertainChannel,contactC]);
    await db.pool.query("INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state) VALUES($1,$2,$3,$4,'OUTGOING','OPERATOR',$5,'UNKNOWN')",
      [uncertain,c,uncertainChannel,conversationC,JSON.stringify({type:'TEXT',text:'uncertain'})]);
    await expect(service.requestChannel(c,instanceC,'WhatsApp Lifecycle C','Authorized cleanup','TENANT',ownerC))
      .rejects.toMatchObject({status:409,code:'LIFECYCLE_PENDING_WORK'});
    expect((await db.pool.query('SELECT archived_at FROM instances WHERE id=$1',[instanceC])).rows[0].archived_at).toBeNull();
  });

  it('blocks company deletion while Chatwoot provisioning or dashboard install is uncertain',async()=>{
    await db.pool.query("UPDATE messaging_messages SET state='FAILED' WHERE organization_id=$1 AND state='UNKNOWN'",[c]);
    await db.pool.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,status) VALUES($1,'https://chatwoot.example.test',3,'READY')",[c]);
    await db.pool.query("INSERT INTO chatwoot_provisioning(organization_id,state) VALUES($1,'UNKNOWN')",[c]);
    await db.pool.query("INSERT INTO chatwoot_embed_apps(organization_id,account_id,destination_revision,install_state) VALUES($1,3,1,'UNKNOWN')",[c]);
    expect(await service.previewOrganization(c)).toMatchObject({canDelete:false,blockers:['PENDING_OR_UNCERTAIN_WORK']});
    await expect(service.requestOrganization(c,'Lifecycle C','Authorized permanent cleanup',actor))
      .rejects.toMatchObject({status:409,code:'LIFECYCLE_PENDING_WORK'});
    await db.pool.query("UPDATE chatwoot_provisioning SET state='READY' WHERE organization_id=$1",[c]);
    await db.pool.query("UPDATE chatwoot_embed_apps SET install_state='UNCONFIGURED' WHERE organization_id=$1",[c]);
    expect(await service.previewOrganization(c)).toMatchObject({canDelete:true});
  });

  it('purges a company but retains shared users and the other tenant',async()=>{
    await db.pool.query('INSERT INTO attendance_owners(organization_id,channel_id) SELECT organization_id,id FROM messaging_channels WHERE organization_id=$1',[c]);
    await db.pool.query("INSERT INTO attendance_sessions(organization_id,channel_id,conversation_id,cycle,state,owner_revision) SELECT organization_id,channel_id,id,1,'RESOLVED',0 FROM messaging_conversations WHERE organization_id=$1",[c]);
    await db.pool.query("UPDATE messaging_messages SET state='FAILED' WHERE organization_id=$1 AND state='UNKNOWN'",[c]);
    const request=await service.requestOrganization(c,'Lifecycle C','Authorized permanent cleanup',actor);
    expect((await db.pool.query('SELECT status FROM organizations WHERE id=$1',[c])).rows[0].status).toBe('DISABLED');
    await expect(db.pool.query("UPDATE organizations SET status='ACTIVE' WHERE id=$1",[c]))
      .rejects.toMatchObject({constraint:'organization_deletion_in_progress'});
    expect(await workerService.processOne()).toBe(true);
    expect(await service.status(c,c,request.operationId)).toMatchObject({status:'COMPLETED'});
    expect((await db.pool.query('SELECT count(*)::int n FROM organizations WHERE id=$1',[c])).rows[0].n).toBe(0);
    expect((await db.pool.query('SELECT * FROM attendance_owners WHERE organization_id=$1',[c])).rows).toEqual([]);
    expect((await db.pool.query('SELECT * FROM attendance_sessions WHERE organization_id=$1',[c])).rows).toEqual([]);
    expect((await db.pool.query('SELECT count(*)::int n FROM users WHERE id=$1',[ownerC])).rows[0].n).toBe(0);
    expect((await db.pool.query('SELECT count(*)::int n FROM users WHERE id=$1',[shared])).rows[0].n).toBe(1);
    expect((await db.pool.query('SELECT count(*)::int n FROM organizations WHERE id=$1',[b])).rows[0].n).toBe(1);
    expect((await db.pool.query('SELECT count(*)::int n FROM memberships WHERE organization_id=$1 AND user_id=$2',[b,shared])).rows[0].n).toBe(1);
  });
});
