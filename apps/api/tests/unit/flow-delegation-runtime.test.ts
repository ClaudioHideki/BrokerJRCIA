import {expect,it} from 'vitest';
import {loadFlowOriginRuntimeOptions} from '../../src/modules/flows/delegation/runtime.js';
it('boots with the empty Compose native-deployment default without manufacturing native evidence',()=>{
 const origin='https://native.example.test';
 for(const value of ['', '   \n\t']){
  const options=loadFlowOriginRuntimeOptions({CHATWOOT_BASE_URL:origin,FLOW_NATIVE_DEPLOYMENTS_JSON:value});
  expect(options.knownNativeOrigins).toEqual(new Set([origin]));expect(options.nativeDeployments).toEqual(new Map());
 }
});
it('still rejects nonempty malformed or incomplete native-deployment evidence',()=>{
 for(const value of ['not-json','{}','[null]',JSON.stringify([{origin:'https://native.example.test',kind:'JRC_NATIVE',provenance:'VERIFIED_DEPLOYMENT',hostSourceSha:'a'.repeat(40)}])])expect(()=>loadFlowOriginRuntimeOptions({FLOW_NATIVE_DEPLOYMENTS_JSON:value})).toThrow();
 const origin='https://native.example.test',proof={origin,kind:'JRC_NATIVE',provenance:'VERIFIED_DEPLOYMENT',hostSourceSha:'a'.repeat(40),hostImageDigest:'sha256:'+'b'.repeat(64),fenceProtocolVersion:1};
 const options=loadFlowOriginRuntimeOptions({FLOW_NATIVE_DEPLOYMENTS_JSON:JSON.stringify([proof])});expect(options.knownNativeOrigins).toEqual(new Set([origin]));expect(options.nativeDeployments.get(origin)).toEqual({kind:proof.kind,provenance:proof.provenance,hostSourceSha:proof.hostSourceSha,hostImageDigest:proof.hostImageDigest,fenceProtocolVersion:1});
});
