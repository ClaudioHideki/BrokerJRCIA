import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { SignJWT } from 'jose';
import Fastify from 'fastify';
import { issueAccessToken } from '@jrc/security';
import { runMigrations } from '../../src/db/migrate.js';
import { inspectSchemaStatus } from '../../src/db/schema-status.js';
import { createPostgresAuthRepository } from '../../src/modules/auth/repository.js';
import { authenticateRequest } from '../../src/http/plugins/authentication.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl } from './helpers/postgres.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';

it('upgrades 0041 with existing sessions and rejects a genuinely legacy JWT only after reset', async () => {
 const admin=requireTestDatabaseAdminUrl(),db=await createIsolatedPostgresDatabase(admin);
 const directory=await mkdtemp(join(tmpdir(),'jrc-reset-upgrade-review-'));
 const folder=join(directory,'migrations');
 const authUrl=new URL(db.connectionString);authUrl.username='jrc_auth';
 const platformUrl=new URL(db.connectionString);platformUrl.username='jrc_platform';
 const auth=new Pool({connectionString:authUrl.toString()}),platform=new Pool({connectionString:platformUrl.toString()});
 const app=Fastify();
 try {
  await cp('apps/api/drizzle/migrations',folder,{recursive:true});
  const journal=JSON.parse(await readFile(join(folder,'meta/_journal.json'),'utf8'));
  journal.entries=journal.entries.filter((entry:{tag:string})=>Number(entry.tag.slice(0,4))<=41);
  expect(journal.entries).toHaveLength(41);
  await writeFile(join(folder,'meta/_journal.json'),JSON.stringify(journal));
  await withGlobalRoleLock(admin,async()=>{
   const client=new Client({connectionString:db.connectionString});await client.connect();
   try {await client.query(await readFile('infra/app/postgres/init-roles.sql','utf8'));await client.query('SET ROLE jrc_migrator');await migrate(drizzle(client),{migrationsFolder:folder,migrationsSchema:'drizzle',migrationsTable:'__drizzle_migrations'});}
   finally {await client.end();}
  });
  const user=randomUUID(),org=randomUUID(),selection=randomUUID(),refresh=randomUUID();
  const expires=new Date(Date.now()+3600_000);
  const client=await db.pool.connect();
  try {await client.query('BEGIN');
   await client.query("INSERT INTO users(id,email,password_hash) VALUES($1,'upgrade-review@example.test','synthetic-old-hash')",[user]);
   await client.query("INSERT INTO organizations(id,name,slug) VALUES($1,'Upgrade Review','upgrade-review')",[org]);
   await client.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')",[org,user]);
   await client.query('INSERT INTO login_sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)',[user,selection,expires]);
   await client.query('INSERT INTO refresh_tokens(organization_id,user_id,family_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5)',[org,user,randomUUID(),refresh,expires]);
   await client.query('COMMIT');
  } catch(error){await client.query('ROLLBACK');throw error;} finally {client.release();}
  await withGlobalRoleLock(admin,()=>runMigrations(db.connectionString));
  expect((await inspectSchemaStatus(db.connectionString)).state).toBe('CURRENT');
  expect((await db.pool.query('SELECT auth_version FROM users WHERE id=$1',[user])).rows[0].auth_version).toBe(0);
  expect((await db.pool.query('SELECT auth_version FROM login_sessions WHERE token_hash=$1',[selection])).rows[0].auth_version).toBe(0);
  expect((await db.pool.query('SELECT auth_version FROM refresh_tokens WHERE token_hash=$1',[refresh])).rows[0].auth_version).toBe(0);
  const repo=createPostgresAuthRepository(auth),secret='independent-review-secret-at-least-32-bytes';
  const now=Math.floor(Date.now()/1000);
  const legacy=await new SignJWT({organization_id:org,role:'OWNER'}).setProtectedHeader({alg:'HS256',typ:'JWT'}).setIssuer('jrc-whatsapp-broker').setAudience('jrc-api').setSubject(user).setJti(randomUUID()).setIssuedAt(now).setExpirationTime(now+600).sign(Buffer.from(secret));
  app.decorate('isUserAuthenticationCurrent',repo.isUserAuthenticationCurrent);
  app.get('/protected',{preHandler:authenticateRequest({jwtSecret:secret,authenticateApiKey:async()=>null})},async()=>({ok:true}));
  const get=(token:string)=>app.inject({url:'/protected',headers:{authorization:`Bearer ${token}`}});
  expect((await get(legacy)).statusCode).toBe(200);
  const rotatedHash=randomUUID();
  expect(await repo.rotateRefreshToken({currentTokenHash:refresh,nextTokenId:randomUUID(),nextTokenHash:rotatedHash,nextExpiresAt:expires,now:new Date()})).toMatchObject({outcome:'ROTATED',authVersion:0});
  await platform.query('SELECT public.revoke_user_authentication($1,$2)',[user,new Date()]);
  expect((await get(legacy)).statusCode).toBe(401);
  const current=await issueAccessToken({userId:user,organizationId:org,role:'OWNER',authVersion:1},secret);
  expect((await get(current)).statusCode).toBe(200);
  expect((await repo.consumeSelection({selectionTokenHash:selection,organizationId:org,now:new Date(),refreshTokenId:randomUUID(),refreshFamilyId:randomUUID(),refreshTokenHash:randomUUID(),refreshExpiresAt:expires})).outcome).not.toBe('SELECTED');
  expect((await repo.rotateRefreshToken({currentTokenHash:rotatedHash,nextTokenId:randomUUID(),nextTokenHash:randomUUID(),nextExpiresAt:expires,now:new Date()})).outcome).not.toBe('ROTATED');
 } finally {await app.close();await auth.end();await platform.end();await db.dispose();await rm(directory,{recursive:true,force:true});}
});
