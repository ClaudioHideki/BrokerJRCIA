import {expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createNativeRegistrationVerifier} from '../../src/modules/flows/delegation/registration/adapter.js';
const request=()=>({challengeId:randomUUID(),nonce:randomUUID(),credentialId:randomUUID(),credentialRevision:1,destinationRevision:2,accountCredentialVersion:3,accountId:7,targets:Array.from({length:100},(_,n)=>({integrationId:randomUUID(),channelId:randomUUID(),inboxId:n+1,transport:'CENTRAL_TRANSPORT' as const,provider:null}))});
const context=()=>({organizationId:randomUUID(),origin:'https://native.example.test',callbackCredential:'x'.repeat(43)});
it('roundtrips 100 real tuples above16KiB with dedicated bearer and no redirect/cookie authority',async()=>{
 const input=request(),body=JSON.stringify({...input,authorized:true});expect(Buffer.byteLength(body)).toBeGreaterThan(16384);expect(Buffer.byteLength(body)).toBeLessThan(65536);
 const fetch=vi.fn(async()=>new Response(body));const result=await createNativeRegistrationVerifier({fetch:fetch as never})(input,context());expect(result).toEqual({...input,authorized:true});
 expect(fetch.mock.calls[0]![0]).toBe('https://native.example.test/api/v1/jrc_flow_native/registration-challenge');expect(fetch.mock.calls[0]![1]).toMatchObject({redirect:'error',credentials:'omit',headers:{authorization:'Bearer '+'x'.repeat(43)}});
});
it('accepts exactly64KiB streamed response and rejects content length or stream overflow before parsing',async()=>{
 const input=request(),body=JSON.stringify({...input,authorized:true}),exact=body+' '.repeat(65536-Buffer.byteLength(body));
 expect(await createNativeRegistrationVerifier({fetch:async()=>new Response(exact) as never})(input,context())).toEqual({...input,authorized:true});
 for(const response of [new Response(body,{headers:{'content-length':'65537'}}),new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(exact));controller.enqueue(new TextEncoder().encode(' '));controller.close();}}))])await expect(createNativeRegistrationVerifier({fetch:async()=>response as never})(input,context())).rejects.toMatchObject({code:'FLOW_REGISTRATION_HOST_UNAVAILABLE'});
});
it('refuses redirects, malformed echo and an indefinitely stalled callback stream within the bounded deadline',async()=>{
 const input=request();
 for(const response of [new Response(null,{status:302,headers:{location:'https://other.test'}}),new Response(JSON.stringify({...input,authorized:true,nonce:randomUUID()}))])await expect(createNativeRegistrationVerifier({fetch:async()=>response as never})(input,context())).rejects.toMatchObject({code:'FLOW_REGISTRATION_HOST_UNAVAILABLE'});
 await expect(createNativeRegistrationVerifier({timeoutMs:10,fetch:async()=>new Response(new ReadableStream({start(){}})) as never})(input,context())).rejects.toMatchObject({code:'FLOW_REGISTRATION_HOST_UNAVAILABLE'});
});
