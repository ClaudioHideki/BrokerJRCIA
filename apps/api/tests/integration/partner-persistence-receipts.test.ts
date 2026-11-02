import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createPartnerEventService} from '../../src/modules/partner-events/service.js';
import {createIntegrationSecrets} from '../../src/modules/integrations/secrets.js';
import {claimDelivery,settleDelivery,type DeliveryClaim} from '../../src/modules/partner-events/worker.js';

describe('partner persistence receipts / real PostgreSQL',()=>{
 let db:Awaited<ReturnType<typeof attendanceDatabase>>;
 let service:ReturnType<typeof createPartnerEventService>;
 beforeAll(async()=>{db=await attendanceDatabase();service=createPartnerEventService({transact:db.transact,secrets:createIntegrationSecrets(Buffer.alloc(32,7).toString('base64'))});});
 afterAll(async()=>{await db?.dispose();});
 const receipt=(claim:DeliveryClaim,id=randomUUID())=>({schemaVersion:1 as const,contract:'PERSISTENCE_RECEIPT_V1' as const,organizationId:claim.organizationId,eventId:claim.eventId,deliveryId:claim.deliveryId,endpointId:claim.endpointId,receiptId:id,persistedAt:'2026-11-01T00:00:00.000Z'});
 it('persists evidence atomically, fences lost leases and preserves terminal receipts',async()=>{
  const tenant=await seedAttendanceTenant(db.database,false),other=await seedAttendanceTenant(db.database,false),key=randomUUID();
  const endpoint=await service.create(tenant.org,{url:'https://partner.example/receipt',ackMode:'PERSISTENCE_RECEIPT_V1'},key);
  await expect(service.create(tenant.org,{url:endpoint.endpoint.url},key)).rejects.toThrow('WEBHOOK_IDEMPOTENCY_CONFLICT');
  const enqueue=async()=>{await db.transact(tenant.org,tx=>tx.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,content,state) VALUES($1,$2,$3,'INCOMING','CONTACT','{"type":"TEXT","text":"synthetic receipt"}','DELIVERED')`,[tenant.org,tenant.channel,tenant.conversation]));return (await db.transact(tenant.org,tx=>claimDelivery(tx,tenant.org)))!;};
  const stale=await enqueue();
  await expect(db.transact(tenant.org,tx=>settleDelivery(tx,stale,{status:'DELIVERED',attempts:1,errorCode:null,delayMs:0}))).rejects.toMatchObject({constraint:'partner_receipt_required'});
  await db.transact(tenant.org,tx=>tx.query(`UPDATE partner_event_deliveries SET lease_expires_at=now()-interval '1 second' WHERE organization_id=$1 AND id=$2`,[tenant.org,stale.deliveryId]));
  const current=(await db.transact(tenant.org,tx=>claimDelivery(tx,tenant.org)))!;
  await db.transact(tenant.org,tx=>settleDelivery(tx,stale,{status:'DELIVERED',attempts:1,errorCode:null,delayMs:0,receipt:receipt(stale)}));
  expect((await service.deliveries(tenant.org,{limit:100})).data[0]).toMatchObject({status:'RUNNING',persistenceReceipt:null});
  const accepted=receipt(current);
  await db.transact(other.org,tx=>settleDelivery(tx,current,{status:'DELIVERED',attempts:2,errorCode:null,delayMs:0,receipt:accepted}));
  expect((await service.deliveries(tenant.org,{limit:100})).data[0]!.status).toBe('RUNNING');
  await db.transact(tenant.org,tx=>settleDelivery(tx,current,{status:'DELIVERED',attempts:2,errorCode:null,delayMs:0,receipt:accepted}));
  const delivered=(await service.deliveries(tenant.org,{limit:100})).data[0]!;
  expect(delivered).toMatchObject({status:'DELIVERED',ackMode:'PERSISTENCE_RECEIPT_V1',persistenceReceipt:{schemaVersion:1,receiptId:accepted.receiptId,persistedAt:accepted.persistedAt}});
  await db.transact(tenant.org,tx=>settleDelivery(tx,current,{status:'PENDING',attempts:2,errorCode:'LATE',delayMs:0}));
  expect((await service.deliveries(tenant.org,{limit:100})).data[0]).toEqual(delivered);
  await expect(db.transact(tenant.org,tx=>tx.query(`UPDATE partner_event_deliveries SET receipt_id=$3 WHERE organization_id=$1 AND id=$2`,[tenant.org,current.deliveryId,randomUUID()]))).rejects.toMatchObject({constraint:'partner_receipt_immutable'});
  const next=await enqueue();
  await expect(db.transact(tenant.org,tx=>settleDelivery(tx,next,{status:'DELIVERED',attempts:1,errorCode:null,delayMs:0,receipt:receipt(next,accepted.receiptId)}))).rejects.toMatchObject({code:'23505',constraint:'partner_delivery_receipt_identity'});
  await db.transact(tenant.org,tx=>settleDelivery(tx,next,{status:'DELIVERED',attempts:1,errorCode:null,delayMs:0,receipt:receipt(next)}));
  expect((await service.deliveries(other.org,{limit:100})).data).toEqual([]);
 });
});
