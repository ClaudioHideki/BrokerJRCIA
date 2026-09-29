import {Client} from 'pg';
import mysql from 'mysql2/promise';
import {lookup} from 'node:dns/promises';
import {connect as connectTcp,isIP} from 'node:net';
import {checkServerIdentity} from 'node:tls';
import {assertPublicAddresses} from '../integrations/chatwoot-safe-http.js';

const prohibited=/\b(?:insert|update|delete|merge|copy|call|do|create|alter|drop|truncate|grant|revoke|set|reset|vacuum|analyze|refresh|reindex|cluster|listen|notify|load|outfile|dumpfile|lock|unlock)\b/iu;
export function assertReadOnlySql(query:string):string{const value=query.trim();if(!value||value.length>50000||value.includes('\0')||value.split(';').filter(part=>part.trim()).length>1||prohibited.test(value)||!/^(?:select\b|with\b)/iu.test(value))throw new Error('AUTOMATION_SQL_READ_ONLY_REQUIRED');return value.replace(/;\s*$/u,'');}
export interface SqlResult{rows:Record<string,unknown>[];rowCount:number;truncated:boolean;durationMs:number}
export async function executeReadOnlySql(input:{type:'POSTGRES'|'MYSQL';connectionString:string;query:string;parameters:unknown[];timeoutMs?:number;maxRows?:number},dependencies:{resolve?:(hostname:string)=>Promise<readonly string[]>}={}):Promise<SqlResult>{
 const query=assertReadOnlySql(input.query),timeout=Math.min(Math.max(input.timeoutMs??5000,100),30000),maxRows=Math.min(Math.max(input.maxRows??100,1),1000),started=Date.now();
 if(!['POSTGRES','MYSQL'].includes(input.type))throw new Error('AUTOMATION_SQL_CREDENTIAL_INVALID');
 const url=new URL(input.connectionString),protocols=input.type==='POSTGRES'?['postgres:','postgresql:']:['mysql:'];
 if(!protocols.includes(url.protocol)||!url.hostname||!url.username||url.hash||!url.pathname.slice(1))throw new Error('AUTOMATION_SQL_CREDENTIAL_INVALID');
 // Never let a connection-string parser override egress, TLS or local certificate paths.
 if([...url.searchParams].some(([name,value])=>name!=='sslmode'||value!=='verify-full'))throw new Error('AUTOMATION_SQL_URL_OPTIONS_REJECTED');
 const hostname=url.hostname.replace(/^\[|\]$/g,''),resolve=dependencies.resolve??(async(host:string)=>(await lookup(host,{all:true,verbatim:true})).map(x=>x.address));
 let timer:ReturnType<typeof setTimeout>|undefined;
 const addresses=await Promise.race([resolve(hostname),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('AUTOMATION_SQL_TIMEOUT')),timeout);})]).finally(()=>clearTimeout(timer));
 try{assertPublicAddresses(addresses);}catch{throw new Error('AUTOMATION_SQL_DESTINATION_REJECTED');}
 // mysql2 verifies DNS names during its TLS upgrade; require a DNS name for both adapters.
 if(isIP(hostname))throw new Error('AUTOMATION_SQL_HOSTNAME_REQUIRED');
 const address=addresses[0]!,port=Number(url.port||(input.type==='POSTGRES'?5432:3306)),identity={user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),database:decodeURIComponent(url.pathname.slice(1))};
 if(input.type==='POSTGRES'){
  const client=new Client({...identity,host:address,port,ssl:{rejectUnauthorized:true,servername:hostname,checkServerIdentity:(_host,cert)=>checkServerIdentity(hostname,cert)},connectionTimeoutMillis:timeout,query_timeout:timeout});
  try{await client.connect();await client.query('BEGIN READ ONLY');await client.query(`SET LOCAL statement_timeout = ${timeout}`);const result=await client.query<Record<string,unknown>>(`SELECT * FROM (${query}) AS jrc_readonly_result LIMIT ${maxRows+1}`,input.parameters);await client.query('COMMIT');return {rows:result.rows.slice(0,maxRows),rowCount:Math.min(result.rows.length,maxRows),truncated:result.rows.length>maxRows,durationMs:Date.now()-started};}
  finally{await client.end();}
 }
 const parameters=input.parameters.map(value=>value===null||['string','number','boolean'].includes(typeof value)?value:JSON.stringify(value)) as Array<string|number|boolean|null>;
 const connection=await mysql.createConnection({...identity,host:hostname,port,stream:()=>connectTcp({host:address,port}),ssl:{rejectUnauthorized:true,verifyIdentity:true},connectTimeout:timeout,multipleStatements:false});
 try{await connection.query({sql:'SET SESSION MAX_EXECUTION_TIME = ?',timeout},[timeout]);await connection.query({sql:'START TRANSACTION READ ONLY',timeout});const [raw]=await connection.execute({sql:`SELECT * FROM (${query}) AS jrc_readonly_result LIMIT ${maxRows+1}`,timeout},parameters);await connection.query({sql:'COMMIT',timeout});const rows=(Array.isArray(raw)?raw:[]) as Record<string,unknown>[];return {rows:rows.slice(0,maxRows),rowCount:Math.min(rows.length,maxRows),truncated:rows.length>maxRows,durationMs:Date.now()-started};}
 finally{connection.destroy();}
}
