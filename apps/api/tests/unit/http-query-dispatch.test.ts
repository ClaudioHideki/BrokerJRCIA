import {describe,it,expect,vi} from 'vitest';
import {createAutomationHttpEffectDispatcher} from '../../src/modules/automations/http-effect.js';
import {AutomationHttpError} from '../../src/modules/automation-integrations/safe-http.js';
import type {OutboxRow} from '../../src/modules/automations/repository.js';
const org='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const config={httpConfigVersion:1,method:'GET',url:'https://api.example.test/lookup',credentialId:id,credentialRevision:3,queryParameters:{search:'{{message}}'},target:'result',timeoutMs:5000,maxResponseBytes:32768,retryAttempts:1};
const item=(payload:Record<string,unknown>)=>({id:'outbox',organizationId:org,payload} as OutboxRow);
const credential={type:'BEARER' as const,secret:{token:'private-test-token'},revision:3,metadata:{allowedOrigins:['https://api.example.test']}};
const fixture=()=>({request:vi.fn().mockResolvedValue({status:200,headers:{},body:'ok',bytes:2,outcome:'success'}),audit:vi.fn().mockResolvedValue(undefined),resolveCredential:vi.fn().mockResolvedValue(credential)});
describe('bounded HTTP query dispatch through the canonical adapter',()=>{
 it('encodes only query values and pins destination, revision, response and redirect policy',async()=>{
  const options=fixture(),value='a&admin=true#x https://other.test {{other}}';
  const result=await createAutomationHttpEffectDispatcher(options).dispatch(item({...config,variables:{message:value},runtimeStateVersion:2,nodeType:'http'}));
  expect(result.kind).toBe('SENT');expect(options.resolveCredential).toHaveBeenCalledWith(org,id);
  const request=options.request.mock.calls[0]![0],url=new URL(request.url);expect(url.origin+url.pathname).toBe(config.url);expect(url.searchParams.get('search')).toBe(value);expect([...url.searchParams.keys()]).toEqual(['search']);
  expect(request).toMatchObject({method:'GET',headers:{authorization:'Bearer private-test-token'},allowedOrigins:credential.metadata.allowedOrigins,redirectLimit:0,maxResponseBytes:32768,timeoutMs:5000,retryAttempts:1});expect(request.body).toBeUndefined();
 });
 it.each([
  {revision:4}, {type:'POSTGRES'}, {metadata:{}}, {metadata:{allowedOrigins:['https://other.test']}},
 ])('fails closed before network for an unsuitable current credential %j',async changes=>{
  const options=fixture();options.resolveCredential.mockResolvedValue({...credential,...changes});
  expect((await createAutomationHttpEffectDispatcher(options).dispatch(item(config))).kind).toBe('FAILED');expect(options.request).not.toHaveBeenCalled();expect(JSON.stringify(options.audit.mock.calls)).not.toContain('private-test-token');
 });
 it.each([{method:'POST'},{httpConfigVersion:2},{headers:{authorization:'inline'}},{body:'mutation'},{url:'https://{{message}}/x'}])('does not downgrade invalid new marker %j to historical IO',async changes=>{
  const options=fixture();expect((await createAutomationHttpEffectDispatcher(options).dispatch(item({...config,...changes}))).kind).toBe('FAILED');expect(options.request).not.toHaveBeenCalled();
 });
 it.each([{type:'BEARER',secret:{token:''}},{type:'BASIC',secret:{username:'user',password:''}},{type:'HTTP_HEADER',secret:{name:'',value:'secret'}}])('refuses an empty new-profile authentication field before network %j',async invalid=>{
  const options=fixture();options.resolveCredential.mockResolvedValue({...credential,...invalid});expect((await createAutomationHttpEffectDispatcher(options).dispatch(item(config))).kind).toBe('FAILED');expect(options.request).not.toHaveBeenCalled();
 });
 it('preserves unmarked mutation payload and UNKNOWN after a lost transport receipt',async()=>{
  const options=fixture();options.request.mockRejectedValue(new AutomationHttpError('AUTOMATION_HTTP_TRANSPORT_FAILED',true));
  const result=await createAutomationHttpEffectDispatcher(options).dispatch(item({method:'POST',url:config.url,credentialId:id,body:{name:'original'}}));
  expect(result.kind).toBe('UNKNOWN');expect(result).not.toHaveProperty('resumePayload');expect(options.request.mock.calls[0]![0]).toMatchObject({method:'POST',body:'{"name":"original"}'});expect(options.request).toHaveBeenCalledTimes(1);
 });
});
