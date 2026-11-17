import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {chatwootEnvironment,type ChatwootOptions} from '../../src/modules/integrations/chatwoot-service.js';
import {createChatwootWorker} from '../../src/modules/integrations/chatwoot-worker.js';

describe('canonical provider status receipts',()=>{
  let db:Awaited<ReturnType<typeof attendanceDatabase>>;
  beforeAll(async()=>{db=await attendanceDatabase();},600_000);
  afterAll(async()=>{await db?.dispose();});
  async function fixture(states:['SENT'|'READ'|'DELIVERED'|'FAILED','SENT'|'READ'|'DELIVERED'|'FAILED'],provider=true){
    const t=await seedAttendanceTenant(db.database),suffix=randomUUID().slice(8),first=`11111111${suffix}`,second=`22222222${suffix}`;
    await db.database.pool.query(`INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id)
      VALUES($1,$2,$3,41,'synthetic-source',51)`,[t.org,t.integration,t.conversation]);
    for(const [index,id]of [first,second].entries()){
      await db.database.pool.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state,upstream_message_id,created_at)
        VALUES($1,$2,$3,$4,'OUTGOING','OPERATOR','{"type":"TEXT","text":"Synthetic multipart reply"}',$5,$6,'2026-01-01T00:00:00Z')`,
        [id,t.org,t.channel,t.conversation,states[index],provider?`provider-${index}`:null]);
      await db.database.pool.query(`INSERT INTO chatwoot_messages(organization_id,integration_id,message_id,remote_message_id) VALUES($1,$2,$3,701)`,[t.org,t.integration,id]);
    }
    await db.database.pool.query(`UPDATE integration_jobs SET status='FAILED' WHERE organization_id=$1`,[t.org]);
    const job=(await db.database.pool.query(`INSERT INTO integration_jobs(organization_id,integration_id,kind,dedupe_key,message_id)
      VALUES($1,$2,'MIRROR_MESSAGE',$3,$4) RETURNING id`,[t.org,t.integration,randomUUID(),second])).rows[0].id;
    const patches:unknown[]=[];
    const options:ChatwootOptions={baseUrl:`https://${t.org}.example.test`,publicOrigin:'https://broker.example.test',
      encryptionKey:Buffer.alloc(32,6).toString('base64'),transact:db.transact,async fetch(input,init){
        const path=new URL(String(input)).pathname;
        if(path==='/api/v1/accounts/7/conversations/51/messages/701'&&init?.method==='PATCH'){
          patches.push(JSON.parse(String(init.body)));return Response.json({});
        }
        throw new Error(`Unexpected synthetic request ${init?.method??'GET'} ${path}`);
      }};
    const vault=chatwootEnvironment(options).vault;
    await db.database.pool.query('UPDATE chatwoot_accounts SET encrypted_token=$2 WHERE organization_id=$1',[t.org,vault.encrypt(`${t.org}:chatwoot-account`,'synthetic-token')]);
    return {...t,first,second,job,patches,options};
  }
  it('uses a stable first canonical sibling instead of whichever status job runs',async()=>{
    const t=await fixture(['READ','DELIVERED']);await createChatwootWorker(t.options).runOnce(t.org);
    expect(t.patches).toEqual([{status:'delivered',broker_delivery:{version:1,canonical_message_id:t.first,provider_message_id:'provider-0',state:'DELIVERED'}}]);
  });
  it('does not manufacture provider proof from a legacy SENT state with no provider ID',async()=>{
    const t=await fixture(['SENT','SENT'],false);await createChatwootWorker(t.options).runOnce(t.org);
    expect(t.patches).toEqual([{status:'sent'}]);
  });
});
