import {describe,it,expect,vi} from 'vitest';
import {createPartnerEventService} from './service.js';
import {createIntegrationSecrets} from '../integrations/secrets.js';
const org='00000000-0000-4000-8000-000000000001',key='00000000-0000-4000-8000-000000000002',delivery='00000000-0000-4000-8000-000000000003',idem='00000000-0000-4000-8000-000000000004';
function harness(result:unknown={},error?:unknown){
 const query=vi.fn(async(sql:string,values:unknown[])=>{
  if(sql.includes('tenant_is_active'))return {rows:[{active:true}]};
  if(values[0]!==key||values[1]!==delivery&&values[1]!==null)throw Error('WRONG_AUTHORITY_OR_ID');
  if(error)throw error;
  return {rows:[{result}]};
 });
 const transact=vi.fn(async(tenant:string,work:any)=>{if(tenant!==org)throw Error('WRONG_TENANT');return work({query});});
 return {service:createPartnerEventService({transact,secrets:createIntegrationSecrets(Buffer.alloc(32,8).toString('base64'))}),transact};
}
describe('partner delivery replay SQL boundary',()=>{
 it('rejects non UUID idempotency before opening a transaction',async()=>{
  const {service,transact}=harness();await expect(service.replay(org,key,delivery,'arbitrary-key')).rejects.toMatchObject({code:'INVALID_IDEMPOTENCY_KEY',statusCode:422});expect(transact).not.toHaveBeenCalled();
 });
 it('keeps stable replay identity after lost ACK',async()=>{
  const result={schemaVersion:1,replay:{id:idem,deliveryId:delivery,eventId:org,endpointId:key,replayNumber:1,priorAttempts:10,acceptedAt:'2026-10-29T00:00:00.000Z'},replayed:true};
  const {service}=harness(result);expect(await service.replay(org,key,delivery,idem)).toEqual(result);
 });
 it.each([['partner_replay_forbidden',403,'PARTNER_REPLAY_FORBIDDEN'],['partner_delivery_not_found',404,'PARTNER_DELIVERY_NOT_FOUND'],['partner_replay_conflict',409,'PARTNER_REPLAY_CONFLICT'],['partner_delivery_not_failed',409,'PARTNER_DELIVERY_NOT_FAILED'],['partner_endpoint_revoked',409,'PARTNER_ENDPOINT_REVOKED'],['partner_event_expired',409,'PARTNER_EVENT_EXPIRED']])('maps %s without exposing SQL data',async(constraint,statusCode,code)=>{
  const {service}=harness({}, {code:'23514',constraint,message:'secret DB detail'});await expect(service.replay(org,key,delivery,idem)).rejects.toMatchObject({code,statusCode});
 });
 it('returns aggregate statistics only from authorized tenant boundary',async()=>{
  const result={schemaVersion:1,retentionDays:30,counts:{PENDING:0,RUNNING:0,DELIVERED:0,FAILED:1,CANCELLED:0},oldestPendingAt:null,expiredLeases:0,replays:2,lifetimeAttempts:30};
  expect(await harness(result).service.deliveryStats(org,key,{})).toEqual(result);
 });
});
