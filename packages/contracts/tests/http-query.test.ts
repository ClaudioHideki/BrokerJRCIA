import {describe,it,expect} from 'vitest';
import * as contracts from '../src/index.js';
import type {z} from 'zod';
const id='11111111-1111-4111-8111-111111111111';
const config={httpConfigVersion:1,method:'GET',url:'https://api.example.test/lookup',credentialId:id,credentialRevision:7,
 queryParameters:{name:'{{name}}'},target:'http.result',timeoutMs:5000,maxResponseBytes:32768,retryAttempts:1};
const schema=(name:string)=>{const value=(contracts as unknown as Record<string,z.ZodType>)[name];expect(value).toBeDefined();return value!;};
describe('delimited HTTP query contract',()=>{
 it('pins GET/static HTTPS and explicit credential revision while keeping encoded query values separate',()=>{
  expect(schema('HttpQueryNodeConfigSchema').parse(config)).toEqual(config);
  for(const change of [{method:'POST'},{httpConfigVersion:2},{credentialRevision:0},{url:'http://api.example.test'},{url:'https://user:password@api.example.test'},{url:'https://{{host}}/lookup'},{url:'https://api.example.test/{{path}}'},{url:'https://api.example.test/lookup?token=literal'},{url:'https://api.example.test/#section'},{headers:{authorization:'secret'}},{body:'mutation'},{target:'constructor'},{timeoutMs:99},{timeoutMs:30001},{maxResponseBytes:32769},{retryAttempts:3}])
   expect(schema('HttpQueryNodeConfigSchema').safeParse({...config,...change}).success).toBe(false);
 });
 it('limits parameter names/values/count without requiring the person to create a JSON schema',()=>{
  expect(schema('HttpQueryNodeConfigSchema').safeParse({...config,queryParameters:{}}).success).toBe(true);
  for(const queryParameters of [{['x'.repeat(65)]:'a'},{x:'a'.repeat(2049)},Object.fromEntries(Array.from({length:21},(_,i)=>['p'+i,'v']))])
   expect(schema('HttpQueryNodeConfigSchema').safeParse({...config,queryParameters}).success).toBe(false);
 });
 it('requires canonical bounded allowed HTTPS origins, excluding embedded secrets and private literal targets',()=>{
  expect(schema('HttpCredentialPolicySchema').parse({allowedOrigins:['https://api.example.test']})).toEqual({allowedOrigins:['https://api.example.test']});
  for(const allowedOrigins of [[],['http://api.example.test'],['https://api.example.test/path'],['https://api.example.test?token=x'],['https://u:p@api.example.test'],['https://localhost'],['https://127.0.0.1'],['https://10.0.0.1'],['https://api.example.test','https://api.example.test']])
   expect(schema('HttpCredentialPolicySchema').safeParse({allowedOrigins}).success).toBe(false);
 });
 it('marks simulations with an exact node and a bounded synthetic response for each canonical port',()=>{
  for(const [outcome,status] of [['success',200],['client_error',404],['server_error',503]] as const)
   expect(schema('HttpSimulationResponseSchema').safeParse({type:'HTTP_RESPONSE',nodeId:'http',outcome,status,body:'resposta fictícia'}).success).toBe(true);
  for(const outcome of ['timeout','unknown'])expect(schema('HttpSimulationResponseSchema').safeParse({type:'HTTP_RESPONSE',nodeId:'http',outcome}).success).toBe(true);
  for(const event of [{type:'HTTP_RESPONSE',nodeId:'',outcome:'success',status:200,body:''},{type:'HTTP_RESPONSE',nodeId:'http',outcome:'success',status:500,body:''},{type:'HTTP_RESPONSE',nodeId:'http',outcome:'success',status:200,body:'é'.repeat(16385)},{type:'HTTP_RESPONSE',nodeId:'http',outcome:'unknown',secret:'token'}])
   expect(schema('HttpSimulationResponseSchema').safeParse(event).success).toBe(false);
 });
 it('validates v1 HTTP config through the canonical node definition without rewriting historical mutations',()=>{
  const definition=contracts.getNodeDefinition('http',1)!;
  expect(definition.schema.safeParse(config).success).toBe(true);
  expect(definition.schema.safeParse({...config,method:'POST'}).success).toBe(false);
  expect(definition.schema.safeParse({method:'POST',url:'https://api.example.test/action',credentialId:id,target:'legacy',body:'original'}).success).toBe(true);
  expect(definition.availability).toBe('AVAILABLE');
 });
});
