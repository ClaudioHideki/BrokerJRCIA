import type {Pool} from 'pg';
// Use valid synthetic Meta asset IDs and the same tenant context required by real onboarding.
export async function seedMetaConnection(pool:Pool,input:{id:string;org:string;channel:string;status?:'READY'|'REVOKED'}) {
 const client=await pool.connect();
 try {
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.organization_id',$1,true)",[input.org]);
  await client.query(`INSERT INTO meta_connections(id,organization_id,channel_id,waba_id,phone_number_id,encrypted_token,graph_version,status)
   VALUES($1,$2,$3,$4,$5,$6,'v25.0',$7)`,[input.id,input.org,input.channel,
   BigInt('0x'+input.org.replaceAll('-','')).toString(),BigInt('0x'+input.id.replaceAll('-','')).toString(),
   input.status==='REVOKED'?null:'synthetic-secret',input.status??'READY']);
  await client.query('COMMIT');
 } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
}
