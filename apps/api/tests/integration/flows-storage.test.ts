import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { welcomeFlow } from '@jrc/contracts';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createFlowService } from '../../src/modules/flows/service.js';
import { createPostgresMessagingRepository } from '../../src/modules/messaging/repository.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';

describe('Flows tenant persistence',()=>{
  let db:IsolatedPostgresDatabase,pool:Pool;
  const a=randomUUID(),b=randomUUID();
  let service:ReturnType<typeof createFlowService>,flowId:string;
  beforeAll(async()=>{
    const admin=requireTestDatabaseAdminUrl();db=await createIsolatedPostgresDatabase(admin);
    await withGlobalRoleLock(admin,()=>runMigrations(db.connectionString));
    const seed=await db.pool.connect();
    try {
      await seed.query('begin');
      await seed.query("insert into organizations(id,name,slug) values($1,'Flows A',$3),($2,'Flows B',$4)",[a,b,'flows-'+a,'flows-'+b]);
      const owner=(await seed.query("insert into users(email,password_hash) values($1,'test-only-no-login') returning id",['flows-'+a+'@example.test'])).rows[0];
      await seed.query("insert into memberships(organization_id,user_id,role) values($1,$3,'OWNER'),($2,$3,'OWNER')",[a,b,owner.id]);
      await seed.query('commit');
    } finally {await seed.query('rollback');seed.release();}
    pool=new Pool({connectionString:connectionStringForRole(db.connectionString,'jrc_app')});
    service=createFlowService({transact:(org,fn)=>withOrganizationTransaction(pool,org,fn)});
  },60000);
  afterAll(async()=>{await pool?.end();await db?.dispose();});
  it('starts disabled, and a tenant cannot grant itself access',async()=>{
    expect(await service.status(a)).toEqual({enabled:false});
    await expect(service.create(a,{name:'Denied',graph:welcomeFlow()})).rejects.toMatchObject({code:'FLOWS_DISABLED'});
    await expect(withOrganizationTransaction(pool,a,tx=>tx.query('insert into flow_features(organization_id,enabled) values($1,true)',[a]))).rejects.toMatchObject({code:'42501'});
    await db.pool.query('insert into flow_features(organization_id,enabled) values($1,true),($2,true)',[a,b]);
  });
  it('creates, publishes an immutable version and hides another tenant records',async()=>{
    const flow=await service.create(a,{name:'Boas-vindas',graph:welcomeFlow()});flowId=flow.id;
    const published=await service.publish(a,flowId,flow.revision);
    expect(published.publishedVersion).toBe(1);
    expect((await service.list(b)).data).toEqual([]);
    await expect(service.get(b,flowId)).rejects.toMatchObject({code:'FLOW_NOT_FOUND'});
    await expect(withOrganizationTransaction(pool,a,tx=>tx.query("update flow_versions set graph='{}' where organization_id=$1",[a]))).rejects.toMatchObject({code:'42501'});
    const graph=welcomeFlow();graph.nodes[1]!.data.text='Nova versão';
    const saved=await service.save(a,flowId,{name:'Atualizado',graph,revision:flow.revision});
    expect(saved.revision).toBe(flow.revision+1);
    const versions=await withOrganizationTransaction(pool,a,tx=>tx.query('select graph from flow_versions where organization_id=$1 and flow_id=$2',[a,flowId]));
    expect(versions.rows[0].graph.nodes[1].data.text).toContain('Olá');
    await expect(service.save(a,flowId,{name:'Obsoleto',graph,revision:flow.revision})).rejects.toMatchObject({code:'FLOW_CHANGED'});
  });
  it('blocks publication with missing outputs and revokes runtime access',async()=>{
    const flow=await service.create(a,{name:'Inválido',graph:{nodes:welcomeFlow().nodes,edges:[]}});
    await expect(service.publish(a,flow.id,flow.revision)).rejects.toMatchObject({code:'FLOW_INVALID'});
    await db.pool.query('update flow_features set enabled=false where organization_id=$1',[a]);
    await expect(service.get(a,flowId)).rejects.toMatchObject({code:'FLOWS_DISABLED'});
  });
  it('executes a direct WhatsApp flow atomically and revokes its queued output when access changes',async()=>{
    const transact=<T>(work:Parameters<typeof withOrganizationTransaction<T>>[2])=>withOrganizationTransaction(pool,b,work);
    const repo=createPostgresMessagingRepository(), flow=await service.create(b,{name:'WhatsApp direto',graph:welcomeFlow()});
    await service.publish(b,flow.id,flow.revision);
    const channel=await transact(async tx=>{
      const provider=(await tx.query("insert into provider_accounts(organization_id,provider,name,credential_reference) values($1,'META','synthetic','vault://synthetic') returning id",[b])).rows[0].id;
      return repo.createChannel(tx,{id:randomUUID(),organizationId:b,providerAccountId:provider,phoneNumberId:'synthetic-phone',wabaId:'synthetic-waba',credentialReference:'vault://synthetic',botPublicId:null,botOriginReference:null});
    });
    await service.bind(b,flow.id,channel.id);
    const conversation=await transact(async tx=>{
      const contact=await repo.upsertContact(tx,{id:randomUUID(),organizationId:b,externalId:'synthetic-contact',displayName:'Ana',consentStatus:'OPTED_IN',consentUpdatedAt:new Date()});
      return repo.getOrCreateConversation(tx,{id:randomUUID(),organizationId:b,channelId:channel.id,contactId:contact.id});
    });
    const incoming={id:randomUUID(),organizationId:b,channelId:channel.id,conversationId:conversation.id,webhookEventKey:'synthetic-once',upstreamMessageId:'synthetic-incoming',content:{type:'TEXT' as const,text:'Olá'}};
    await transact(tx=>repo.recordIncoming(tx,incoming));await transact(tx=>repo.recordIncoming(tx,{...incoming,id:randomUUID()}));
    const claim=await transact(tx=>repo.claimBotTurn(tx,{organizationId:b,workerId:randomUUID(),now:new Date(),leaseMs:120000}));
    expect(claim).not.toBeNull();await service.runTurn(claim!);await service.runTurn(claim!);
    expect((await service.runs(b,flow.id)).data).toHaveLength(1);
    const outputs=await transact(tx=>repo.claimOutgoing(tx,{organizationId:b,workerId:randomUUID(),now:new Date(),leaseMs:120000,limit:10}));
    expect(outputs).toHaveLength(1);
    await db.pool.query('update flow_features set enabled=false,revision=revision+1 where organization_id=$1',[b]);
    const eligibility=await transact(tx=>repo.validateClaim(tx,{organizationId:b,messageId:outputs[0]!.message.id,leaseToken:outputs[0]!.leaseToken,now:new Date()}));
    expect(eligibility).toMatchObject({eligible:false,reason:'FLOW_REVOKED'});
  });
});
