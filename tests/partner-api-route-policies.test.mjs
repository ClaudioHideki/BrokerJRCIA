import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {expect,it} from 'vitest';
import {buildRouteInventory} from '../scripts/security/inventory-routes.mjs';
const root=resolve(import.meta.dirname,'..');
it('classifies all generic partner operations with exact scopes, tenant and source handlers',async()=>{
 const openapi=JSON.parse(await readFile(resolve(root,'docs/api/openapi.json'),'utf8'));
 const inventory=await buildRouteInventory({rootDirectory:root,openapi});
 const selected=(method,path)=>inventory.find(route=>route.method===method&&route.path===path);
 const text=selected('POST','/v1/messaging/channels/{id}/partner-text');
 expect(text).toMatchObject({authentication:'CURRENT_ORGANIZATION_API_KEY',permission:'MESSAGING_SEND_SCOPE',tenantRls:true,
  idempotency:'TENANT_CHANNEL_KEY_BODY_HASH_AND_AUTHORIZING_API_KEY',challengeExposure:'NO_STORE_MESSAGE_CONTENT',handlerFile:'apps/api/src/http/routes/messaging.ts'});
 expect(text.ownershipCheck).toContain('RECHECK_BEFORE_DISPATCH');
 expect(text.requestSchemas).toEqual(expect.arrayContaining(['path:id','header:idempotency-key','body:application/json']));
 expect(selected('POST','/v1/messaging/instances/{id}/partner-activate')).toMatchObject({authentication:'CURRENT_ORGANIZATION_API_KEY',permission:'INSTANCES_WRITE_AND_MESSAGING_SEND_SCOPES',tenantRls:true,
  idempotency:'HEADER_REQUIRED_CANONICAL_TENANT_INSTANCE_CHANNEL_REUSE',handlerFile:'apps/api/src/http/routes/integrations.ts'});
 for(const [method,path,idempotency] of [
  ['GET','/v1/partner-webhooks','READ_ONLY'],['POST','/v1/partner-webhooks','TENANT_HASHED_KEY_NORMALIZED_URL_EXACT_REPLAY'],
  ['DELETE','/v1/partner-webhooks/{id}','REVOCATION_ONLY_CANCEL_PENDING_AND_LEASED_DELIVERIES'],
  ['GET','/v1/partner-events','READ_ONLY_COMMIT_ORDERED_CURSOR_RETENTION_WATERMARK'],['GET','/v1/partner-webhook-deliveries','READ_ONLY_BOUNDED_DIAGNOSTICS'],
 ]){
  const route=selected(method,path);expect(route).toMatchObject({authentication:'JWT_CURRENT_MEMBERSHIP_OR_CURRENT_ORGANIZATION_API_KEY',permission:'OWNER_ADMIN_OR_WEBHOOKS_MANAGE_SCOPE',tenantRls:true,idempotency,handlerFile:'apps/api/src/http/routes/partner-webhooks.ts'});
  expect(route.handlerLine).toBeGreaterThan(0);expect(route.ownershipCheck).toContain('AUTHENTICATED_TENANT');
  if(method==='POST')expect(route.challengeExposure).toBe('NO_STORE_ENCRYPTED_SIGNING_SECRET_EXACT_AUTHORIZED_REPLAY_ONLY');
 }
});
it('records messaging:read on every existing literal GET guard, including private media',async()=>{
 const openapi=JSON.parse(await readFile(resolve(root,'docs/api/openapi.json'),'utf8'));
 const inventory=await buildRouteInventory({rootDirectory:root,openapi});
 const reads=inventory.filter(route=>route.method==='GET'&&route.path.startsWith('/v1/messaging/'));
 expect(reads).toHaveLength(9);
 for(const route of reads)expect(route).toMatchObject({authentication:'JWT_CURRENT_MEMBERSHIP_OR_CURRENT_ORGANIZATION_API_KEY',permission:'CURRENT_MEMBER_OR_MESSAGING_READ_SCOPE',tenantRls:true,handlerFile:'apps/api/src/http/routes/messaging.ts'});
 expect(reads.find(route=>route.path==='/v1/messaging/media/{id}').ownershipCheck).toContain('RECHECK_AFTER_PRIVATE_MEDIA_READ');
});
