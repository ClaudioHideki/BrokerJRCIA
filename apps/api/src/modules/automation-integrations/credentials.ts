import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { OrganizationTransaction, TenantTransaction } from '../../db/tenant-transaction.js';
import { createIntegrationSecrets } from '../integrations/secrets.js';

export const CredentialTypeSchema=z.enum(['HTTP_HEADER','BEARER','BASIC','POSTGRES','MYSQL','AI_PROVIDER','GENERIC_JSON']);
export type CredentialType=z.infer<typeof CredentialTypeSchema>;
export interface CredentialRow {id:string;organizationId:string;name:string;type:CredentialType;encryptedSecret:string|null;keyVersion:number;fingerprint:string;metadata:Record<string,unknown>;status:'ACTIVE'|'REVOKED';revision:number;lastTestedAt:Date|null;createdAt:Date;updatedAt:Date}
export interface CredentialRepository {
 list(tx:TenantTransaction,org:string):Promise<CredentialRow[]>;get(tx:TenantTransaction,org:string,id:string,lock?:boolean):Promise<CredentialRow|null>;
 insert(tx:TenantTransaction,row:{org:string;id:string;name:string;type:CredentialType;encrypted:string;keyVersion:number;fingerprint:string;metadata:Record<string,unknown>}):Promise<CredentialRow>;
 rotate(tx:TenantTransaction,row:{org:string;id:string;revision:number;encrypted:string;keyVersion:number;fingerprint:string}):Promise<CredentialRow|null>;
 revoke(tx:TenantTransaction,org:string,id:string,revision:number):Promise<CredentialRow|null>;tested(tx:TenantTransaction,org:string,id:string):Promise<CredentialRow>;
}
const columns=`id,organization_id AS "organizationId",name,type,encrypted_secret AS "encryptedSecret",key_version AS "keyVersion",fingerprint,metadata,status,revision,last_tested_at AS "lastTestedAt",created_at AS "createdAt",updated_at AS "updatedAt"`;
export function createPostgresCredentialRepository():CredentialRepository{return {
 async list(tx,org){return (await tx.query<CredentialRow>(`select ${columns} from automation_credentials where organization_id=$1 order by updated_at desc`,[org])).rows;},
 async get(tx,org,id,lock=false){return (await tx.query<CredentialRow>(`select ${columns} from automation_credentials where organization_id=$1 and id=$2 ${lock?'for update':''}`,[org,id])).rows[0]??null;},
 async insert(tx,row){return (await tx.query<CredentialRow>(`insert into automation_credentials(organization_id,id,name,type,encrypted_secret,key_version,fingerprint,metadata) values($1,$2,$3,$4,$5,$6,$7,$8) returning ${columns}`,[row.org,row.id,row.name,row.type,row.encrypted,row.keyVersion,row.fingerprint,JSON.stringify(row.metadata)])).rows[0]!;},
 async rotate(tx,row){return (await tx.query<CredentialRow>(`update automation_credentials set encrypted_secret=$4,key_version=$5,fingerprint=$6,revision=revision+1,status='ACTIVE',updated_at=now() where organization_id=$1 and id=$2 and revision=$3 and status='ACTIVE' returning ${columns}`,[row.org,row.id,row.revision,row.encrypted,row.keyVersion,row.fingerprint])).rows[0]??null;},
 async revoke(tx,org,id,revision){return (await tx.query<CredentialRow>(`update automation_credentials set encrypted_secret=null,status='REVOKED',revision=revision+1,updated_at=now() where organization_id=$1 and id=$2 and revision=$3 and status='ACTIVE' returning ${columns}`,[org,id,revision])).rows[0]??null;},
 async tested(tx,org,id){return (await tx.query<CredentialRow>(`update automation_credentials set last_tested_at=now(),updated_at=now() where organization_id=$1 and id=$2 returning ${columns}`,[org,id])).rows[0]!;},
};}

export interface CredentialVault {activeVersion:number;seal(org:string,type:CredentialType,id:string,secret:Record<string,unknown>):{encrypted:string;fingerprint:string;keyVersion:number};open(row:CredentialRow):Record<string,unknown>}
export function createCredentialVault(serialized:string):CredentialVault{
 const parsed=z.record(z.string().regex(/^\d+$/),z.string()).parse(JSON.parse(serialized)) as Record<string,string>,versions=Object.keys(parsed).map(Number).sort((a,b)=>a-b);if(!versions.length)throw new Error('CREDENTIAL_VAULT_KEYRING_EMPTY');
 const vaults=new Map(versions.map(version=>[version,createIntegrationSecrets(parsed[String(version)]!)])),activeVersion=versions.at(-1)!;
 const context=(org:string,type:CredentialType,id:string,version:number)=>`${org}:${type}:${id}:key-${version}`;
 return {activeVersion,seal(org,type,id,secret){const value=JSON.stringify(z.record(z.string(),z.unknown()).parse(secret));if(Buffer.byteLength(value)>65536)throw new Error('CREDENTIAL_SECRET_TOO_LARGE');const vault=vaults.get(activeVersion)!;return {encrypted:vault.encrypt(context(org,type,id,activeVersion),value),fingerprint:createHmac('sha256',parsed[String(activeVersion)]!).update(value).digest('hex'),keyVersion:activeVersion};},
  open(row){if(row.status!=='ACTIVE'||!row.encryptedSecret)throw new Error('CREDENTIAL_REVOKED');const vault=vaults.get(row.keyVersion);if(!vault)throw new Error('CREDENTIAL_KEY_VERSION_UNAVAILABLE');return z.record(z.string(),z.unknown()).parse(JSON.parse(vault.decrypt(context(row.organizationId,row.type,row.id,row.keyVersion),row.encryptedSecret)));}};
}

export class CredentialError extends Error{constructor(readonly code:string,readonly statusCode=422){super(code);}}
export interface CredentialTester {test(type:CredentialType,secret:Record<string,unknown>,metadata:Record<string,unknown>):Promise<void>}
const view=(row:CredentialRow)=>({schemaVersion:1 as const,id:row.id,organizationId:row.organizationId,name:row.name,type:row.type,status:row.status,revision:row.revision,keyVersion:row.keyVersion,fingerprint:row.fingerprint.slice(0,12),metadata:row.metadata,lastTestedAt:row.lastTestedAt?.toISOString()??null,createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString()});
export function createCredentialService(options:{transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;vault:CredentialVault;repository?:CredentialRepository;tester?:CredentialTester}){
 const repository=options.repository??createPostgresCredentialRepository();const get=async(tx:TenantTransaction,org:string,id:string,lock=false)=>{const row=await repository.get(tx,org,id,lock);if(!row)throw new CredentialError('CREDENTIAL_NOT_FOUND',404);return row;};
 return {list:(org:string)=>options.transact(org,async tx=>({data:(await repository.list(tx,org)).map(view)})),get:(org:string,id:string)=>options.transact(org,async tx=>view(await get(tx,org,id))),
  create:(org:string,input:{name:string;type:CredentialType;secret:Record<string,unknown>;metadata:Record<string,unknown>})=>options.transact(org,async tx=>{const id=randomUUID(),sealed=options.vault.seal(org,input.type,id,input.secret);return view(await repository.insert(tx,{org,id,name:input.name.trim(),type:input.type,...sealed,metadata:input.metadata}));}),
  rotate:(org:string,id:string,input:{revision:number;secret:Record<string,unknown>})=>options.transact(org,async tx=>{const current=await get(tx,org,id,true),sealed=options.vault.seal(org,current.type,id,input.secret),row=await repository.rotate(tx,{org,id,revision:input.revision,...sealed});if(!row)throw new CredentialError('CREDENTIAL_CHANGED',409);return view(row);}),
  revoke:(org:string,id:string,revision:number)=>options.transact(org,async tx=>{await get(tx,org,id,true);const row=await repository.revoke(tx,org,id,revision);if(!row)throw new CredentialError('CREDENTIAL_CHANGED',409);return view(row);}),
  test:(org:string,id:string)=>options.transact(org,async tx=>{const row=await get(tx,org,id);if(!options.tester)throw new CredentialError('CREDENTIAL_TEST_UNAVAILABLE',503);await options.tester.test(row.type,options.vault.open(row),row.metadata);return view(await repository.tested(tx,org,id));}),
  resolve:(org:string,id:string)=>options.transact(org,async tx=>{const row=await get(tx,org,id);return {type:row.type,secret:options.vault.open(row),metadata:row.metadata};}),_repository:repository};
}
export type CredentialService=ReturnType<typeof createCredentialService>;
