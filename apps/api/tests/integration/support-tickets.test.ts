import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { createOwnerMembership } from '../../src/modules/memberships/repository.js';
import { createUser } from '../../src/modules/users/repository.js';
import { createSupportService, withSupportPlatformTransaction, type SupportActor } from '../../src/modules/support/service.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';

describe('support tickets with real tenant boundaries', () => {
  let database: IsolatedPostgresDatabase, appPool: Pool, staffPool: Pool;
  let first: SupportActor, other: SupportActor, staff: SupportActor;
  let service: ReturnType<typeof createSupportService>;
  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl(); database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, () => runMigrations(database.connectionString));
    const organizations = await runInAdminTransaction(database.pool, async tx => {
      const result=[];
      for(const [name,slug] of [['Support One','support-one'],['Support Two','support-two']] as const) {
        const organization=await createOrganization(tx,{name,slug});
        const user=await createUser(tx,{email:slug+'@example.test',passwordHash:'synthetic-unused-hash'});
        await createOwnerMembership(tx,{organizationId:organization.id,userId:user.id});
        result.push({...organization,ownerId:user.id});
      }
      return result;
    });
    first = { kind: 'TENANT', organizationId: organizations[0]!.id, actorId: organizations[0]!.ownerId, canWrite: true };
    other = { kind: 'TENANT', organizationId: organizations[1]!.id, actorId: organizations[1]!.ownerId, canWrite: true };
    staff = { kind: 'PLATFORM', actorId: randomUUID() };
    appPool = new Pool({ connectionString: connectionStringForRole(database.connectionString, 'jrc_app') });
    const staffUrl=new URL(database.connectionString); staffUrl.username='jrc_platform';staffUrl.password='';
    staffPool = new Pool({ connectionString: staffUrl.toString() });
    service = createSupportService({ transact: (org, work) => withOrganizationTransaction(appPool, org, work), staffTransact: work => withSupportPlatformTransaction(staffPool, work) });
  }, 60_000);
  afterAll(async () => { await appPool?.end(); await staffPool?.end(); await database?.dispose(); });

  it('creates once on retry and refuses cross-tenant reads and replies', async () => {
    const input = { title: 'Conexão desconectada', message: 'Não consigo reconectar meu canal.', requestId: randomUUID() };
    const [one, replay] = await Promise.all([service.create(first, input), service.create(first, input)]);
    expect(one.ticket.id).toBe(replay.ticket.id); expect(one.messages).toHaveLength(1);
    await expect(service.read(other, one.ticket.id)).rejects.toMatchObject({ code: 'SUPPORT_NOT_FOUND' });
    await expect(service.reply(other, one.ticket.id, { message: 'Outra empresa', revision: 1, requestId: randomUUID() })).rejects.toMatchObject({ code: 'SUPPORT_NOT_FOUND' });
    expect((await service.list(other)).data).toHaveLength(0);
    expect((await service.list(staff)).data.some(t => t.id === one.ticket.id)).toBe(true);
    await expect(service.create(first, { ...input, title: 'Corpo alterado' })).rejects.toMatchObject({ code: 'SUPPORT_IDEMPOTENCY_CONFLICT' });
  });

  it('supports replies, optimistic concurrency, assignment, resolution and client reopening', async () => {
    const created = await service.create(first, { title: 'Ajuda com canal', message: 'Solicito atendimento.', requestId: randomUUID() });
    const assigned = await service.update(staff, created.ticket.id, { revision: 1, status: 'IN_PROGRESS', assignToMe: true });
    expect(assigned.ticket.assigneeId).toBe(staff.actorId);
    const reply = { revision: 2, message: 'Conferimos a conexão.', requestId: randomUUID() };
    const answered = await service.reply(staff, created.ticket.id, reply);
    expect(answered.ticket.status).toBe('WAITING_CUSTOMER'); expect(answered.ticket.firstResponseAt).not.toBeNull();
    const replay = await service.reply(staff, created.ticket.id, reply);
    expect(replay.messages).toHaveLength(3);
    expect(replay.messages.filter(item=>item.kind==='REPLY')).toHaveLength(2);
    await expect(service.update(staff, created.ticket.id, { revision: 2, status: 'RESOLVED' })).rejects.toMatchObject({ code: 'SUPPORT_CHANGED' });
    const resolved = await service.update(staff, created.ticket.id, { revision: 3, status: 'RESOLVED' });
    const reopened = await service.reply(first, created.ticket.id, { revision: resolved.ticket.revision, message: 'Ainda preciso de ajuda.', requestId: randomUUID() });
    expect(reopened.ticket.status).toBe('OPEN');
  });

  it('forces tenant isolation and fences writes after the company is disabled', async () => {
    if(first.kind!=='TENANT'||other.kind!=='TENANT')throw new Error('Invalid fixture');
    const ticket=await service.create(first,{title:'Teste de isolamento',message:'Registro sintético.',requestId:randomUUID()});
    const rows=await withOrganizationTransaction(appPool,other.organizationId,tx=>tx.query('select id from support_tickets where id=$1',[ticket.ticket.id]));
    expect(rows.rows).toHaveLength(0);
    const noScope=await appPool.query('select id from support_tickets');
    expect(noScope.rows).toHaveLength(0);
    const policies=await database.pool.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where relname in ('support_tickets','support_messages')");
    expect(policies.rows).toHaveLength(2);
    expect(policies.rows.every(row=>row.relrowsecurity&&row.relforcerowsecurity)).toBe(true);
    await database.pool.query("update organizations set status='DISABLED' where id=$1",[first.organizationId]);
    await expect(service.reply(first,ticket.ticket.id,{revision:1,message:'Negado.',requestId:randomUUID()})).rejects.toMatchObject({code:'SUPPORT_ORGANIZATION_DISABLED'});
    // The database boundary also protects direct app-role writes, not only HTTP.
    await expect(withOrganizationTransaction(appPool,first.organizationId,tx=>tx.query(
      'insert into support_messages(organization_id,ticket_id,actor_id,author_kind,body,request_id,request_hash) values($1,$2,$3,$4,$5,$6,$7)',
      [first.organizationId,ticket.ticket.id,first.actorId,'TENANT','Negado.',randomUUID(),'synthetic'],
    ))).rejects.toMatchObject({constraint:'support_organization_writable'});
  });
});
