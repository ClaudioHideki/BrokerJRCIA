import {describe,expect,it,vi} from 'vitest';
import {Client} from 'pg';
import mysql from 'mysql2/promise';
import {executeReadOnlySql} from '../../src/modules/automation-integrations/sql.js';

vi.mock('pg',()=>({Client:vi.fn()}));
vi.mock('mysql2/promise',()=>({default:{createConnection:vi.fn()}}));
const publicDns=vi.fn(async()=>['8.8.8.8']);
const request={type:'POSTGRES' as const,connectionString:'postgresql://reader:fake@db.example/data',query:'SELECT 1',parameters:[]};
describe('automation SQL egress',()=>{
 it.each(['127.0.0.1','10.0.0.1','169.254.169.254','::1','192.168.1.1'])('rejects %s before connecting',async address=>{
  vi.mocked(Client).mockClear();
  await expect(executeReadOnlySql(request,{resolve:async()=>[address]})).rejects.toThrow('AUTOMATION_SQL_DESTINATION_REJECTED');
  expect(Client).not.toHaveBeenCalled();
 });
 it.each(['sslmode=disable','sslmode=no-verify','sslmode=require','host=127.0.0.1','sslcert=/tmp/key'])('rejects unsafe/override query %s',async query=>{
  await expect(executeReadOnlySql({...request,connectionString:`${request.connectionString}?${query}`},{resolve:publicDns})).rejects.toThrow('AUTOMATION_SQL_URL_OPTIONS_REJECTED');
 });
 it('pins resolved IP and enforces original TLS identity without re-parsing a connection string',async()=>{
  const client={connect:vi.fn(),query:vi.fn(async()=>({rows:[{ok:1}]})),end:vi.fn()};
  vi.mocked(Client).mockImplementation(function(){return client as never;});
  const result=await executeReadOnlySql(request,{resolve:publicDns});
  expect(result.rows).toEqual([{ok:1}]);
  const config=vi.mocked(Client).mock.calls.at(-1)![0] as any;
  expect(config.connectionString).toBeUndefined();expect(config.host).toBe('8.8.8.8');
  expect(config.ssl).toMatchObject({rejectUnauthorized:true,servername:'db.example'});
  expect(client.end).toHaveBeenCalledOnce();
 });
 it('rejects mixed public/private DNS answers',async()=>{
  await expect(executeReadOnlySql(request,{resolve:async()=>['8.8.8.8','10.0.0.1']})).rejects.toThrow('AUTOMATION_SQL_DESTINATION_REJECTED');
 });
 it('bounds stalled DNS before constructing a client',async()=>{
  await expect(executeReadOnlySql({...request,timeoutMs:100},{resolve:()=>new Promise(()=>{})})).rejects.toThrow('AUTOMATION_SQL_TIMEOUT');
 });
 it('pins mysql socket while preserving hostname identity verification',async()=>{
  const connection={query:vi.fn(),execute:vi.fn(async()=>[[{ok:1}]]),destroy:vi.fn()};
  vi.mocked(mysql.createConnection).mockResolvedValue(connection as never);
  await executeReadOnlySql({...request,type:'MYSQL',connectionString:'mysql://reader:fake@db.example/data'},{resolve:publicDns});
  const config=vi.mocked(mysql.createConnection).mock.calls.at(-1)![0] as any;
  expect(config.host).toBe('db.example');expect(config.stream).toBeTypeOf('function');
  expect(config.ssl).toMatchObject({rejectUnauthorized:true,verifyIdentity:true});
 });
});
