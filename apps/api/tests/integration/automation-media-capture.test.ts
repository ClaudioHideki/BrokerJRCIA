import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createAutomationService,createEventRouter,createExecutionService} from '../../src/modules/automations/service.js';
import {createPostgresMessagingRepository} from '../../src/modules/messaging/repository.js';
import {createMessagingWorker} from '../../src/modules/messaging/worker.js';
import {AUTOMATION_ORIGIN} from '@jrc/contracts';
const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,data,position:{x:0,y:0}});
const edge=(source:string,target:string,port='next')=>({id:source+port,source,target,port});
const mediaConfig={inputConfigVersion:3,inputType:'image',variable:'attachment',maxAttempts:2,timeoutSeconds:300};

describe('canonical attachment capture persistence',()=>{
 let lab:Awaited<ReturnType<typeof attendanceDatabase>>;
 beforeAll(async()=>{lab=await attendanceDatabase();},60000);afterAll(async()=>{await lab?.dispose();});
 async function setup(config:Record<string,unknown>=mediaConfig,thenText=false){
  const t=await seedAttendanceTenant(lab.database,false);await lab.database.pool.query('INSERT INTO flow_features(organization_id,enabled) VALUES($1,true)',[t.org]);
  const graph={nodes:[node('start','start'),node('capture','input',config),node('end','end'),
    ...(thenText?[node('text','input',{variable:'answer',inputConfigVersion:1})]:[])],
    edges:[edge('start','capture'),edge('capture',thenText?'text':'end'),...(config.inputConfigVersion===2||config.inputConfigVersion===3?[edge('capture','end','exhausted')]:[]),
      ...(config.timeoutSeconds===undefined?[]:[edge('capture','end','timeout')]),...(thenText?[edge('text','end')]:[])]};
  const service=createAutomationService({transact:lab.transact,enabled:true}),draft=await service.create(t.org,{name:'Synthetic attachment capture',graph});
  await service.publish(t.org,draft.id,draft.draft.revision);await service.bind(t.org,draft.id,{channelId:t.channel});
  await lab.database.pool.query("UPDATE messaging_conversations SET mode='BOT',bot_public_id=$3,bot_origin_reference=$4 WHERE organization_id=$1 AND id=$2",[t.org,t.conversation,draft.id,AUTOMATION_ORIGIN]);
  const router=createEventRouter({transact:lab.transact,enabled:true});
  const text=(value:string)=>router.route(t.org,{channelId:t.channel,conversationId:t.conversation,eventKey:randomUUID(),text:value});
  const media=(messageId:string)=>router.route(t.org,{channelId:t.channel,conversationId:t.conversation,eventKey:'message:'+messageId,text:'',mediaMessageId:messageId});
  const worker=()=>createExecutionService({transact:lab.transact,enabled:true});
  const attachment=async(kind='image')=>{
   const mediaId=randomUUID(),messageId=randomUUID(),fileName=kind==='image'?'synthetic.png':'synthetic.pdf';
   await lab.database.pool.query(`INSERT INTO messaging_media(id,organization_id,channel_id,source,source_key,kind,file_name,descriptor)
     VALUES($1::uuid,$2,$3,'META',$1::uuid::text,$4,$5,'{}')`,[mediaId,t.org,t.channel,kind,fileName]);
   await lab.transact(t.org,tx=>createPostgresMessagingRepository().recordIncoming(tx,{id:messageId,organizationId:t.org,channelId:t.channel,
     conversationId:t.conversation,webhookEventKey:messageId,upstreamMessageId:messageId,
     content:{type:'MEDIA',mediaId,kind:kind as 'image'|'document',fileName,caption:'NEVER_CAPTURE_CAPTION'}}));
   return{messageId,mediaId,kind,fileName,source:'CANONICAL_MESSAGE'};
  };
  return{...t,router,text,media,worker,attachment};
 }
 it('routes normal incoming media through its durable bot job and the execution worker',async()=>{
  const t=await setup(),initial=await t.text('Oi');await t.worker().runOnce(t.org);const attachment=await t.attachment();
  expect((await lab.database.pool.query('SELECT status FROM messaging_bot_jobs WHERE organization_id=$1 AND message_id=$2',[t.org,attachment.messageId])).rows).toEqual([{status:'PENDING'}]);
  const messaging=createMessagingWorker({repository:createPostgresMessagingRepository(),transact:lab.transact,automations:t.router,
    async resolveMetaClient(){throw Error('Unexpected external send');},async resolveTypebotClient(){throw Error('Unexpected Typebot call');}});
  await messaging.runOnce(t.org);await t.worker().runOnce(t.org);
  expect(await t.worker().get(t.org,initial.execution!.id)).toMatchObject({status:'COMPLETED',state:{variables:{attachment}}});
  expect((await lab.database.pool.query('SELECT status FROM messaging_bot_jobs WHERE organization_id=$1 AND message_id=$2',[t.org,attachment.messageId])).rows).toEqual([{status:'COMPLETED'}]);
 });
 it('preserves the Typebot text-only ingress contract instead of scheduling media for a legacy external bot',async()=>{
  const t=await setup();await lab.database.pool.query("UPDATE messaging_conversations SET bot_origin_reference='cloud' WHERE organization_id=$1 AND id=$2",[t.org,t.conversation]);
  const attachment=await t.attachment();expect((await lab.database.pool.query('SELECT status FROM messaging_bot_jobs WHERE organization_id=$1 AND message_id=$2',[t.org,attachment.messageId])).rows).toEqual([]);
 });
 it('captures a scoped internal image reference once after worker replacement without requiring a download',async()=>{
  const t=await setup(),initial=await t.text('Oi');await t.worker().runOnce(t.org);const attachment=await t.attachment();
  expect(await t.media(attachment.messageId)).toMatchObject({resumed:true});expect(await t.media(attachment.messageId)).toMatchObject({duplicate:true});
  await t.worker().runOnce(t.org);const result=await t.worker().get(t.org,initial.execution!.id);
  expect(result).toMatchObject({status:'COMPLETED',state:{variables:{attachment}}});
  expect(JSON.stringify(result.nodes)).not.toContain('synthetic.png');expect(JSON.stringify(result.state)).not.toContain('NEVER_CAPTURE_CAPTION');
  expect((await lab.database.pool.query('SELECT status FROM messaging_media WHERE id=$1',[attachment.mediaId])).rows[0].status).toBe('PENDING');
 });
 it('keeps its deadline and attempt count when the wrong media kind precedes a valid file',async()=>{
  const t=await setup({...mediaConfig,inputType:'file'}),initial=await t.text('Oi');await t.worker().runOnce(t.org);
  const before=await t.worker().get(t.org,initial.execution!.id),image=await t.attachment();await t.media(image.messageId);await t.worker().runOnce(t.org);
  const retry=await t.worker().get(t.org,initial.execution!.id);
  expect(retry.state).toMatchObject({waiting:{inputConfigVersion:3,invalidAttempts:1,deadlineAt:(before.state as {waiting:{deadlineAt:number}}).waiting.deadlineAt}});
  const file=await t.attachment('document');await t.media(file.messageId);await t.worker().runOnce(t.org);
  expect(await t.worker().get(t.org,initial.execution!.id)).toMatchObject({status:'COMPLETED',state:{variables:{attachment:file}}});
 });
 it('consumes media without starting a new Flow when there is no V3 wait',async()=>{
  const t=await setup(),attachment=await t.attachment();expect(await t.media(attachment.messageId)).toMatchObject({execution:null});
  expect((await lab.database.pool.query('SELECT id FROM automation_executions WHERE organization_id=$1',[t.org])).rows).toEqual([]);
  expect((await lab.database.pool.query('SELECT status FROM automation_events WHERE organization_id=$1',[t.org])).rows).toEqual([{status:'CONSUMED'}]);
 });
 it.each([undefined,1,2])('does not advance legacy/text capture V%s with a media caption',async version=>{
  const t=await setup({variable:'answer',...(version?{inputConfigVersion:version}:{}),...(version===2?{inputType:'text',maxAttempts:2}:{})});
  const initial=await t.text('Oi');await t.worker().runOnce(t.org);const before=await t.worker().get(t.org,initial.execution!.id),attachment=await t.attachment();
  expect(await t.media(attachment.messageId)).toMatchObject({resumed:false});expect(await t.worker().runOnce(t.org)).toEqual({processed:false});
  expect((await t.worker().get(t.org,initial.execution!.id)).state).toEqual(before.state);
  await t.text('Real text');await t.worker().runOnce(t.org);expect(await t.worker().get(t.org,initial.execution!.id)).toMatchObject({state:{variables:{answer:'Real text'}}});
 });
 it('does not let a second queued attachment satisfy the next historical text wait',async()=>{
  const t=await setup(mediaConfig,true),initial=await t.text('Oi');await t.worker().runOnce(t.org);
  const first=await t.attachment(),second=await t.attachment();await t.media(first.messageId);await t.media(second.messageId);await t.worker().runOnce(t.org);
  const result=await t.worker().get(t.org,initial.execution!.id);expect(result).toMatchObject({status:'WAITING',state:{variables:{attachment:first},waiting:{nodeId:'text'}}});
  expect((result.state as {variables:Record<string,unknown>}).variables).not.toHaveProperty('answer');
  expect((await lab.database.pool.query("SELECT status FROM automation_events WHERE organization_id=$1 AND event_key=$2",[t.org,'message:'+second.messageId])).rows[0].status).toBe('CONSUMED');
 });
 it('rejects another tenant/channel/conversation before recording the reference',async()=>{
  const t=await setup(),other=await setup(),attachment=await t.attachment();
  for(const scope of [{org:other.org,channel:other.channel,conversation:other.conversation},{org:t.org,channel:randomUUID(),conversation:t.conversation},{org:t.org,channel:t.channel,conversation:randomUUID()}]){
   await expect(t.router.route(scope.org,{channelId:scope.channel,conversationId:scope.conversation,eventKey:randomUUID(),text:'',mediaMessageId:attachment.messageId}))
    .rejects.toMatchObject({code:'AUTOMATION_INPUT_MEDIA_NOT_FOUND',statusCode:404});
  }
  expect((await lab.database.pool.query('SELECT id FROM automation_events WHERE organization_id=ANY($1::uuid[])',[[t.org,other.org]])).rows).toEqual([]);
 });
});
