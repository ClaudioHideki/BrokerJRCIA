import {describe,it,expect} from 'vitest';
import {loadPartnerEventsWorkerConfig} from './partner-events-worker.js';
describe('partner event worker startup',()=>{
 it('requires direct app role and an independent encryption key',()=>{
  const env={DATABASE_URL:'postgres://jrc_app:synthetic@localhost/broker',PARTNER_WEBHOOK_ENCRYPTION_KEY:Buffer.alloc(32,6).toString('base64')};
  expect(loadPartnerEventsWorkerConfig(env).intervalMs).toBe(1000);
  expect(()=>loadPartnerEventsWorkerConfig({...env,DATABASE_URL:'postgres://postgres:synthetic@localhost/broker'})).toThrow('PARTNER_WORKER_REQUIRES_APP_ROLE');
  expect(()=>loadPartnerEventsWorkerConfig({...env,PARTNER_WEBHOOK_ENCRYPTION_KEY:''})).toThrow();
  expect(()=>loadPartnerEventsWorkerConfig({...env,PARTNER_EVENTS_WORKER_INTERVAL_MS:'0'})).toThrow();
 });
});
