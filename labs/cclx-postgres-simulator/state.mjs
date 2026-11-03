import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, realpath, lstat, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { Pool } from 'pg';

export function requireLabOnly(options={}) {
  if(process.env.NODE_ENV==='production'||options.environment==='production')throw Error('PRODUCTION_REFUSED');
  if(options.labOnly!==true)throw Error('LAB_ONLY_REQUIRED');
}
export function validateDatabaseUrl(value,owned=false) {
  try {
    const url=new URL(value),name=url.pathname.slice(1);
    if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.search||url.hash||
      !(owned?/^jrc_test_cclx_[a-f0-9]{32}$/:/^(lab_[a-z0-9_]+|jrc_test_[a-z0-9_]+)$/).test(name))throw Error();
    return url;
  } catch {throw Error('UNSAFE_TEST_DATABASE');}
}
export function requireTestDatabaseUrl(env=process.env) {
  if(env.NODE_ENV==='production')throw Error('PRODUCTION_REFUSED');
  if(!env.TEST_DATABASE_ADMIN_URL)throw Error('TEST_DATABASE_ADMIN_URL_REQUIRED');
  validateDatabaseUrl(env.TEST_DATABASE_ADMIN_URL);
  return env.TEST_DATABASE_ADMIN_URL;
}
export const poolFor=url=>new Pool({connectionString:url,max:3,connectionTimeoutMillis:3000,idleTimeoutMillis:1000,query_timeout:5000});

export async function createIsolatedLabDatabase(options={}) {
  requireLabOnly(options);
  // CREATE DATABASE can wait for a template checkpoint. A client-only five-second
  // timeout abandons the receipt while PostgreSQL may still create the database.
  // Keep the connection until the server confirms success or cancels the DDL.
  // This budget is only for disposable laboratory provisioning, not delivery SQL.
  const adminUrl=requireTestDatabaseUrl(),admin=new Pool({connectionString:adminUrl,max:1,
    connectionTimeoutMillis:3000,idleTimeoutMillis:1000,statement_timeout:30000,query_timeout:0}),
    name=`jrc_test_cclx_${randomUUID().replaceAll('-','')}`,token=randomUUID();
  const url=new URL(adminUrl);url.pathname='/'+name;
  let pool,created=false;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);created=true;pool=poolFor(url.toString());
    await pool.query(`CREATE TABLE cclx_lab_marker(token uuid PRIMARY KEY);
      CREATE TABLE cclx_lab_inbox(organization_id uuid NOT NULL,event_id uuid NOT NULL,body_hash text NOT NULL,
        envelope jsonb NOT NULL,committed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,event_id));
      CREATE TABLE cclx_lab_projections(organization_id uuid NOT NULL,event_id uuid NOT NULL,sequence bigint NOT NULL,
        PRIMARY KEY(organization_id,event_id),FOREIGN KEY(organization_id,event_id) REFERENCES cclx_lab_inbox);
      CREATE TABLE cclx_lab_media_receipts(organization_id uuid NOT NULL,event_id uuid NOT NULL,receipt jsonb NOT NULL,
        PRIMARY KEY(organization_id,event_id),FOREIGN KEY(organization_id,event_id) REFERENCES cclx_lab_inbox);`);
    await pool.query('INSERT INTO cclx_lab_marker VALUES($1)',[token]);
  } catch(error) {await pool?.end();if(created)await admin.query(`DROP DATABASE "${name}"`);await admin.end();throw error;}
  return {connectionString:url.toString(),token,query:(...args)=>pool.query(...args),
    async dispose(){
      // This exact random database was created by this call. Never terminate other connections or use DROP FORCE.
      const row=(await pool.query('SELECT token FROM cclx_lab_marker')).rows;
      if(row.length!==1||row[0].token!==token)throw Error('LAB_DATABASE_MARKER_MISMATCH');
      validateDatabaseUrl(url.toString(),true);await pool.end();
      try {await admin.query(`DROP DATABASE "${name}"`);} finally {await admin.end();}
    }};
}

export async function validateMediaState(state) {
  try {
    const directory=await realpath(state.directory),root=await realpath(tmpdir());
    if(directory!==resolve(state.directory)||dirname(directory)!==root||!/^cclx-pg-lab-[A-Za-z0-9]+$/.test(basename(directory))||(await lstat(directory)).isSymbolicLink())throw Error();
    const markerPath=join(directory,'state.json');
    if((await lstat(markerPath)).isSymbolicLink())throw Error();
    const marker=JSON.parse(await readFile(markerPath,'utf8'));
    if(marker.kind!=='CCLX_PG_SYNTHETIC_ONLY_V1'||marker.token!==state.token)throw Error();
    return directory;
  } catch {throw Error('INVALID_LAB_MEDIA_STATE');}
}
export async function createPrivateMediaState(options={}) {
  requireLabOnly(options);
  const directory=await mkdtemp(join(await realpath(tmpdir()),'cclx-pg-lab-')),token=randomUUID();
  await chmod(directory,0o700);
  await writeFile(join(directory,'state.json'),JSON.stringify({kind:'CCLX_PG_SYNTHETIC_ONLY_V1',token}),{flag:'wx',mode:0o600});
  const state={directory,token};
  return {...state,async dispose(){const target=await validateMediaState(state);await rm(target,{recursive:true});}};
}
