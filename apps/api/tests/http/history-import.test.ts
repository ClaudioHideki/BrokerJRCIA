import {afterEach,describe,expect,it} from 'vitest';
import {issueAccessToken} from '@jrc/security';
import {buildApp} from '../../src/app.js';
import type {ChannelFacade} from '../../src/modules/channels/facade.js';

const org='4f2491a2-6853-4ac2-a7ef-c997813a9182',actor='81555d45-b1a2-4a3f-ab95-c1459b0df0d0',channel='519b77a6-a4e5-409a-85c8-d78fc155c525';
const secret='history-route-test-secret-at-least-32-bytes';
const apps:Array<ReturnType<typeof buildApp>>=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});

describe('administrator history import boundary',()=>{
 it('shows an unavailable capability for an existing QR channel when no source is configured',async()=>{
  const app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({verifyPasswordOrDummy:async()=>false}),channels:{
   jwtSecret:secret,authenticateApiKey:async()=>null,resolveCurrentRole:async()=> 'OWNER',
   service:{get:async()=>({provider:'QR',organizationId:org,id:channel})} as unknown as ChannelFacade}});apps.push(app);
  const authorization=`Bearer ${await issueAccessToken({userId:actor,organizationId:org,role:'OWNER'},secret)}`;
  const response=await app.inject({method:'GET',url:`/v1/channels/${channel}/history-import/capability`,headers:{authorization}});
  expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toEqual({schemaVersion:1,organizationId:org,channelId:channel,available:false,reason:'SOURCE_NOT_CONFIGURED',maxRecords:0});
 });
 it('uses current membership and rejects request-supplied manifests before any import',async()=>{
  let role:'OWNER'|'OPERATOR'|null='OWNER',starts=0;
  const historyImport={start:async()=>{starts++;throw new Error('UNEXPECTED_SOURCE_CALL');}};
  const app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({verifyPasswordOrDummy:async()=>false}),channels:{
   jwtSecret:secret,authenticateApiKey:async()=>null,resolveCurrentRole:async()=>role,service:{} as ChannelFacade,historyImport} as never});apps.push(app);
  const authorization=`Bearer ${await issueAccessToken({userId:actor,organizationId:org,role:'OWNER'},secret)}`;
  const selection={from:'2026-10-01T00:00:00.000Z',to:'2026-10-19T00:00:00.000Z',maxRecords:100};
  const call=(payload:unknown)=>app.inject({method:'POST',url:`/v1/channels/${channel}/history-import`,headers:{authorization,'idempotency-key':channel},payload});
  expect((await call({...selection,manifest:{totalRecords:0}})).statusCode).toBe(400);
  role='OPERATOR';expect((await call(selection)).statusCode).toBe(403);
  role=null;expect((await call(selection)).statusCode).toBe(403);expect(starts).toBe(0);
  expect((await app.inject({method:'GET',url:`/v1/channels/${channel}/history-import/capability`,headers:{'x-api-key':'synthetic'}})).statusCode).not.toBe(200);
 });
});
