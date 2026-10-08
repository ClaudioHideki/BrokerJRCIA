import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attendanceDatabase } from './helpers/attendance.js';
import { snapshotLegacyCommercialAssignment } from '../../src/modules/commercial-plans/service.js';

/** Synthetic database cardinality and RLS proof; no WhatsApp socket or throughput claim. */
describe('500 logical tenants and 10000 isolated channel records',()=>{
  let lab:Awaited<ReturnType<typeof attendanceDatabase>>;
  const tenants=Array.from({length:500},()=>({org:randomUUID(),qr:randomUUID(),meta:randomUUID()}));
  beforeAll(async()=>{
    lab=await attendanceDatabase();
    const client=await lab.database.pool.connect();
    try{
      await client.query('begin');
      await client.query(`insert into organizations(id,name,slug)
        select org,'Logical capacity fixture','logical-'||org::text
        from jsonb_to_recordset($1::jsonb) as t(org uuid,qr uuid,meta uuid)`,[JSON.stringify(tenants)]);
      await client.query(`insert into users(id,email,password_hash)
        select org,org::text||'@example.test','synthetic-only'
        from jsonb_to_recordset($1::jsonb) as t(org uuid,qr uuid,meta uuid)`,[JSON.stringify(tenants)]);
      await client.query(`insert into memberships(organization_id,user_id,role)
        select org,org,'OWNER' from jsonb_to_recordset($1::jsonb) as t(org uuid,qr uuid,meta uuid)`,[JSON.stringify(tenants)]);
      // Configure the admitted logical capacity using the existing limit projection;
      // no quota, RLS or provider trigger is disabled for this fixture.
      await client.query('update organization_limits set max_instances=20 where organization_id=any($1::uuid[])',[tenants.map(tenant=>tenant.org)]);
      for(const tenant of tenants)await snapshotLegacyCommercialAssignment(client,tenant.org);
      await client.query(`insert into provider_accounts(id,organization_id,provider,name)
        select qr,org,'BAILEYS'::provider_kind,'Synthetic QR' from jsonb_to_recordset($1::jsonb) as t(org uuid,qr uuid,meta uuid)
        union all select meta,org,'META'::provider_kind,'Synthetic Meta' from jsonb_to_recordset($1::jsonb) as t(org uuid,qr uuid,meta uuid)`,[JSON.stringify(tenants)]);
      await client.query(`with created as (
        insert into instances(organization_id,provider_account_id,name,upstream_instance_key)
        select t.org,t.qr,'logical-'||s::text,t.org::text||'-logical-'||s::text
        from jsonb_to_recordset($1::jsonb) as t(org uuid,qr uuid,meta uuid) cross join generate_series(1,10) s
        returning id,organization_id,provider_account_id
      ) insert into messaging_channels(organization_id,provider_account_id,provider,instance_id,credential_reference)
        select organization_id,provider_account_id,'BAILEYS',id,'synthetic-only' from created`,[JSON.stringify(tenants)]);
      // Reused remote IDs deliberately exercise tenant scope rather than global identity assumptions.
      await client.query(`insert into messaging_channels(organization_id,provider_account_id,provider,phone_number_id,waba_id,credential_reference)
        select t.org,t.meta,'META','synthetic-phone-'||s::text,'synthetic-waba','synthetic-only'
        from jsonb_to_recordset($1::jsonb) as t(org uuid,qr uuid,meta uuid) cross join generate_series(1,10) s`,[JSON.stringify(tenants)]);
      await client.query('commit');
    }catch(error){await client.query('rollback');throw error;}
    finally{client.release();}
  },60000);
  afterAll(async()=>{await lab?.dispose();});
  it('persists the explicit mixed-provider logical target without creating external sessions',async()=>{
    expect((await lab.database.pool.query('select count(*)::int as n from organizations')).rows).toEqual([{n:500}]);
    expect((await lab.database.pool.query('select provider,count(*)::int as n from messaging_channels group by provider order by provider')).rows).toEqual([{provider:'BAILEYS',n:5000},{provider:'META',n:5000}]);
    expect((await lab.database.pool.query('select count(*)::int as n from provider_operations')).rows).toEqual([{n:0}]);
    expect((await lab.database.pool.query(`select count(*)::int as n from organization_commercial_plans a
      join commercial_plan_versions v on v.id=a.plan_version_id join organization_limits l on l.organization_id=a.organization_id
      where l.max_instances=20 and (v.limits->>'maxInstances')::int=20`)).rows).toEqual([{n:500}]);
  });
  it('keeps every tenant scoped to its own twenty channels under the actual runtime role',async()=>{
    for(let offset=0;offset<tenants.length;offset+=8){
      await Promise.all(tenants.slice(offset,offset+8).map(tenant=>lab.transact(tenant.org,async tx=>{
        const rows=(await tx.query<{organization_id:string;provider:string;n:number}>(
          'select organization_id,provider,count(*)::int as n from messaging_channels group by organization_id,provider order by provider')).rows;
        expect(rows).toEqual([{organization_id:tenant.org,provider:'BAILEYS',n:10},{organization_id:tenant.org,provider:'META',n:10}]);
      })));
    }
  },30000);
  it('refuses cross-tenant updates even with a known channel ID',async()=>{
    const foreign=(await lab.database.pool.query('select id from messaging_channels where organization_id=$1 limit 1',[tenants[1]!.org])).rows[0].id;
    await lab.transact(tenants[0]!.org,async tx=>{
      expect((await tx.query('select id from messaging_channels where id=$1',[foreign])).rows).toEqual([]);
      expect((await tx.query("update messaging_channels set credential_reference='must-not-change' where id=$1 returning id",[foreign])).rowCount).toBe(0);
    });
    expect((await lab.database.pool.query('select credential_reference from messaging_channels where id=$1',[foreign])).rows[0].credential_reference).toBe('synthetic-only');
  });
});
