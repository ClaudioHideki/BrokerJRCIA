import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {Client} from 'pg';
import {z} from 'zod';

const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const request=z.array(z.strictObject({organization:z.uuid(),integration:z.uuid(),account:positive,inbox:positive,
  revision:positive,message:positive,conversation:positive.nullable()})).min(1).max(1000);

// The source relation is selected from two compiled names after checking the schema.
export async function reportQrEvidence(client,raw){
  const entries=request.parse(raw);
  const text=await readFile(new URL('../docs/operations/qr-outbound-evidence.sql',import.meta.url),'utf8');
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
    await client.query("SET LOCAL statement_timeout='5s'");
    const traced=(await client.query("SELECT to_regclass('public.qr_traced_dispatch_attempts') IS NOT NULL AS present")).rows[0].present;
    const sql=traced?text.replace('LEFT JOIN qr_dispatch_attempts a ON','LEFT JOIN qr_traced_dispatch_attempts a ON'):text;
    const results=[];
    for(const item of entries){
      await client.query("SELECT set_config('app.organization_id',$1,true)",[item.organization]);
      const rows=await client.query(sql,[item.organization,item.integration,item.account,item.inbox,item.revision,item.message,item.conversation]);
      results.push({inbox:item.inbox,message:item.message,conversation:item.conversation,rows:rows.rows});
    }
    await client.query('COMMIT');
    return {schema:traced?'0097-or-later':'pre-trace',results};
  }catch(error){await client.query('ROLLBACK');throw error;}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  const run=async()=>{
    const url=new URL(process.env.DATABASE_URL??'');
    if(url.username!=='jrc_app')throw Error('APP_ROLE_REQUIRED');
    let bytes=0;const chunks=[];
    for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>1048576)throw Error('INPUT_TOO_LARGE');chunks.push(chunk);}
    const input=Buffer.concat(chunks).toString('utf8');
    const client=new Client({connectionString:url.toString(),connectionTimeoutMillis:5000});
    await client.connect();
    try{process.stdout.write(JSON.stringify(await reportQrEvidence(client,JSON.parse(input)))+'\n');}
    finally{await client.end();}
  };
  run().catch(()=>{process.stderr.write('QR_EVIDENCE_REPORT_FAILED\n');process.exitCode=1;});
}
