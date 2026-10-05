import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { runMigrations } from '../../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../../src/db/tenant-transaction.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './postgres.js';
import { withGlobalRoleLock } from './global-role-lock.js';
import { connectionStringForRole } from './task7.js';

export async function seedAttendanceTenant(database: IsolatedPostgresDatabase, remote = true) {
  const org = randomUUID(), channel = randomUUID(), conversation = randomUUID(), integration = randomUUID();
  const automation = randomUUID();
  const graph=JSON.stringify({nodes:[{id:'start',type:'start',label:'Start',position:{x:0,y:0},data:{}},{id:'end',type:'end',label:'End',position:{x:200,y:0},data:{}}],edges:[{id:'next',source:'start',target:'end',port:'next'}]});
  const client = await database.pool.connect();
  try {
    await client.query('begin');
    await client.query(`insert into organizations(id,name,slug) values($1,'Attendance',$2)`, [org, `attendance-${org}`]);
    const actor = randomUUID();
    await client.query(`insert into users(id,email,password_hash) values($1,$2,'test-only')`, [actor, `${actor}@example.test`]);
    await client.query(`insert into memberships(organization_id,user_id,role) values($1,$2,'OWNER')`, [org, actor]);
    const provider = (await client.query(`insert into provider_accounts(organization_id,provider,name,credential_reference)
      values($1,'META','test','vault://test') returning id`, [org])).rows[0].id;
    await client.query(`insert into messaging_channels(id,organization_id,provider_account_id,phone_number_id,waba_id,credential_reference)
      values($1,$2,$3,$4,'test','vault://test')`, [channel, org, provider, `synthetic-${channel}`]);
    const contact = (await client.query(`insert into messaging_contacts(organization_id,external_id) values($1,'synthetic') returning id`, [org])).rows[0].id;
    await client.query(`insert into messaging_conversations(id,organization_id,channel_id,contact_id) values($1,$2,$3,$4)`, [conversation, org, channel, contact]);
    await client.query(`insert into automation_definitions(organization_id,id,name,draft_graph) values($1,$2,'test',$3)`, [org, automation,graph]);
    await client.query(`insert into automation_versions(organization_id,automation_id,version,graph,checksum) values($1,$2,1,$3,$4)`, [org, automation,graph, 'a'.repeat(64)]);
    if (remote) {
      await client.query(`insert into chatwoot_accounts(organization_id,base_url,account_id,status) values($1,$2,7,'READY')`, [org, `https://${org}.example.test`]);
      await client.query(`insert into chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status) values($1,$2,$3,9,'test','READY')`, [integration, org, channel]);
    }
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
  return { org, channel, conversation, integration, automation,
    scope: { organizationId: org, channelId: channel, integrationId: integration, destinationRevision: 1, accountId: 7, inboxId: 9 } };
}

export async function attendanceDatabase() {
  const admin = requireTestDatabaseAdminUrl();
  const database = await createIsolatedPostgresDatabase(admin);
  await withGlobalRoleLock(admin, () => runMigrations(database.connectionString));
  const pool = new Pool({ connectionString: connectionStringForRole(database.connectionString, 'jrc_app') });
  return { database,
    transact: <T>(org: string, work: Parameters<typeof withOrganizationTransaction<T>>[2]) => withOrganizationTransaction(pool, org, work),
    dispose: async () => { await pool.end(); await database.dispose(); },
  };
}
