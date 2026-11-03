import {describe, expect, it} from 'vitest';
import {ChatwootError} from '../../src/modules/integrations/chatwoot-client.js';
import {createJobFailureDiagnostic, readJobFailureDiagnostic} from '../../src/modules/integrations/job-failure-diagnostics.js';

const at=new Date('2026-11-02T20:30:00.000Z');
describe('bounded durable delivery diagnostics',()=>{
 it('records only observed transport facts and the persisted worker outcome',()=>{
  const error=new ChatwootError('CHATWOOT_OUTCOME_UNKNOWN',false,true,503,{phase:'HTTP_STATUS',method:'POST'});
  expect(createJobFailureDiagnostic(error,2,'UNKNOWN',at)).toEqual({version:1,phase:'HTTP_STATUS',method:'POST',httpStatus:503,attempt:2,settlement:'UNKNOWN',failedAt:at.toISOString()});
 });
 it('does not invent HTTP facts for historical or internal failures',()=>{
  expect(readJobFailureDiagnostic(null)).toBeNull();
  expect(readJobFailureDiagnostic(undefined)).toBeNull();
  expect(createJobFailureDiagnostic(new Error('https://private.test/?token=secret'),1,'FAILED',at)).toEqual({version:1,phase:'UNKNOWN',method:null,httpStatus:null,attempt:1,settlement:'FAILED',failedAt:at.toISOString()});
 });
 it('preserves uncertainty rather than turning a mutation timeout into a rejection',()=>{
  const error=new ChatwootError('CHATWOOT_OUTCOME_UNKNOWN',false,true,undefined,{phase:'TRANSPORT',method:'POST'});
  expect(createJobFailureDiagnostic(error,1,'UNKNOWN',at)).toMatchObject({phase:'TRANSPORT',httpStatus:null,settlement:'UNKNOWN'});
 });
 it('fails closed on malformed or unexpected stored fields',()=>{
  const valid=createJobFailureDiagnostic(new ChatwootError('CHATWOOT_UNAVAILABLE',true,false,429,{phase:'HTTP_STATUS',method:'GET'}),1,'RETRY_SCHEDULED',at);
  expect(readJobFailureDiagnostic(valid)).toEqual(valid);
  for(const value of [{...valid,privateUrl:'https://secret.test'}, {...valid,httpStatus:999}, {...valid,phase:'token-secret'}, {...valid,attempt:0}, {...valid,failedAt:'private message'}, {...valid,version:2}]) expect(readJobFailureDiagnostic(value)).toBeNull();
 });
});
