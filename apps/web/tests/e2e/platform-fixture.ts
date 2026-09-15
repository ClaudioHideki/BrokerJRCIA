import {Pool} from 'pg';
import {hashPassword} from '@jrc/security';
import {encryptSeed,totp} from '../../../api/src/modules/platform/crypto.js';
import {PlatformService} from '../../../api/src/modules/platform/service.js';
// Synthetic fixtures only; never import these deterministic seeds into production.
export const PLATFORM_TEST_CREDENTIALS={email:'platform-admin@example.test',password:'synthetic-platform-password',seedHex:Buffer.alloc(20,71).toString('hex')};
export const platformTestCredentials=(projectName:string)=>({...PLATFORM_TEST_CREDENTIALS,email:projectName.toLowerCase().includes('mobile')?'platform-mobile@example.test':'platform-desktop@example.test'});
export const platformTestTotp=(_projectName?:string)=>totp(Buffer.from(PLATFORM_TEST_CREDENTIALS.seedHex,'hex'),Math.floor(Date.now()/30000));
export async function createPlatformFixture(admin:Pool,connectionString:string,origin:string) {
 const key=Buffer.alloc(32,81),seed=Buffer.from(PLATFORM_TEST_CREDENTIALS.seedHex,'hex');
 for(const email of [PLATFORM_TEST_CREDENTIALS.email,platformTestCredentials('desktop').email,platformTestCredentials('mobile').email]) await admin.query('insert into platform_users(email,password_hash,role,mfa_seed) values($1,$2,$3,$4)',[email,await hashPassword(PLATFORM_TEST_CREDENTIALS.password),'SUPER_ADMIN',encryptSeed(seed,key)]);
 const url=new URL(connectionString);url.username='jrc_platform';url.password='';
 const pool=new Pool({connectionString:url.toString()});
 return {routeOptions:{service:new PlatformService(pool,key,{mode:'password',nodeEnv:'test',origin}),origin,secureCookies:false},credentials:PLATFORM_TEST_CREDENTIALS,cleanup:()=>pool.end()};
}
