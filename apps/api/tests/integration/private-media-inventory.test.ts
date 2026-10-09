import {afterAll,beforeAll,expect,it} from 'vitest';
import {attendanceDatabase} from './helpers/attendance.js';
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
const tables=['media_private_objects','media_private_operations'];
beforeAll(async()=>{db=await attendanceDatabase();});
afterAll(async()=>{await db?.dispose();});
it('checks exact C2 ownership, FORCE RLS, policy expressions and separate runtime grants',async()=>{
 const client=await db.database.pool.connect();try{
  await client.query('BEGIN');
  await client.query('CREATE TEMP TABLE private_policy_reference(organization_id uuid,kind text)');
  await client.query(`CREATE POLICY tenant_reference ON private_policy_reference TO jrc_app
   USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)
   WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)`);
  await client.query(`CREATE POLICY put_reference ON private_policy_reference TO jrc_app
   USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)
   WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid AND kind='PUT')`);
  await client.query(`CREATE POLICY delete_reference ON private_policy_reference TO jrc_lifecycle USING(true) WITH CHECK(kind='DELETE')`);
  const references=(await client.query(`SELECT polname,pg_get_expr(polqual,polrelid) AS qual,pg_get_expr(polwithcheck,polrelid) AS with_check FROM pg_policy WHERE polrelid='pg_temp.private_policy_reference'::regclass`)).rows;
  const ref=(name:string)=>references.find(row=>row.polname===name)!;
  const expected=tables.flatMap(tablename=>[
   {tablename,policyname:'lifecycle_migrator',roles:['jrc_migrator'],cmd:'ALL',permissive:'PERMISSIVE',qual:'true',with_check:'true'},
   {tablename,policyname:'media_private_lifecycle',roles:['jrc_lifecycle'],cmd:'ALL',permissive:'PERMISSIVE',qual:'true',with_check:tablename==='media_private_operations'?ref('delete_reference').with_check:'true'},
   {tablename,policyname:'media_private_tenant',roles:['jrc_app'],cmd:'ALL',permissive:'PERMISSIVE',qual:ref('tenant_reference').qual,with_check:ref(tablename==='media_private_operations'?'put_reference':'tenant_reference').with_check},
  ]);
  const order=(rows:any[])=>rows.sort((a,b)=>(a.tablename+':'+a.policyname).localeCompare(b.tablename+':'+b.policyname));
  const actual=(await client.query(`SELECT tablename,policyname,roles::text[] AS roles,cmd,permissive,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename=ANY($1::text[])`,[tables])).rows;
  expect(order(actual)).toEqual(order(expected));
  expect((await client.query(`SELECT relname AS tablename,pg_get_userbyid(relowner) AS owner,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[]) ORDER BY relname`,[tables])).rows)
   .toEqual(tables.map(tablename=>({tablename,owner:'jrc_migrator',relrowsecurity:true,relforcerowsecurity:true})));
  for(const table of tables)for(const role of ['jrc_app','jrc_auth','jrc_platform','jrc_lifecycle'])for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']){
   const allowed=role==='jrc_app'?['SELECT','INSERT','UPDATE']:role==='jrc_lifecycle'?(table==='media_private_operations'?['SELECT','INSERT','UPDATE']:['SELECT','UPDATE']):[];
   expect((await client.query('SELECT has_table_privilege($1,$2,$3) AS allowed',[role,'public.'+table,privilege])).rows[0].allowed,`${role}:${table}:${privilege}`).toBe(allowed.includes(privilege));
  }
  expect((await client.query(`SELECT c.relname,a.privilege_type FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1::text[]) AND a.grantee=0`,[tables])).rows).toEqual([]);
  expect((await client.query('SELECT table_name FROM lifecycle_purge_catalogue WHERE table_name=ANY($1::text[]) ORDER BY table_name',[tables])).rows).toEqual(tables.map(table_name=>({table_name})));
 }finally{await client.query('ROLLBACK');client.release();}
});
it('checks explicit private/lifecycle function owners, execution ACLs, security modes and fixed search paths',async()=>{
 const functions=[
  ['media_private_worker_organizations(uuid,integer)',true,true,false],
  ['media_private_channel_open(uuid,uuid)',true,true,false],
  ['media_private_immutable()',false,false,false],
  ['media_private_delete_authorized()',true,false,false],
  ['lifecycle_cancel_safe_work(uuid,uuid)',true,false,false],
  ['lifecycle_cancel_safe_work_before_private_media(uuid,uuid)',true,false,false],
  ['lifecycle_pending_count(uuid,uuid,uuid)',true,false,true],
  ['lifecycle_pending_count_before_private_media(uuid,uuid,uuid)',true,false,true],
  ['lifecycle_validate_purge(uuid,uuid,text)',true,false,true],
  ['lifecycle_validate_purge_before_private_media(uuid,uuid,text)',true,false,true],
 ] as const;
 for(const [signature,definer,app,lifecycle] of functions){
  const p=(await db.database.pool.query(`SELECT pg_get_userbyid(proowner) AS owner,prosecdef,proconfig FROM pg_proc WHERE oid=to_regprocedure($1)`,['public.'+signature])).rows[0];
  expect(p?.owner,signature).toBe('jrc_migrator');expect(p?.prosecdef,signature).toBe(definer);if(definer)expect(p.proconfig,signature).toContain('search_path=pg_catalog, public');
  expect((await db.database.pool.query(`SELECT coalesce(r.rolname,'PUBLIC') AS role,a.privilege_type,a.is_grantable FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE p.oid=to_regprocedure($1) AND a.grantee<>p.proowner ORDER BY role`,['public.'+signature])).rows)
   .toEqual([...(app?[{role:'jrc_app',privilege_type:'EXECUTE',is_grantable:false}]:[]),...(lifecycle?[{role:'jrc_lifecycle',privilege_type:'EXECUTE',is_grantable:false}]:[])]);
 }
});
