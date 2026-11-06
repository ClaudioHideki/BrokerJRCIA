import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {expect,it} from 'vitest';
import {buildRouteInventory} from '../scripts/security/inventory-routes.mjs';
const root=resolve(import.meta.dirname,'..');
it('classifies the fresh routing snapshot as scoped Control-key-only metadata and verifies its source boundary',async()=>{
 const path='/v1/integrations/chatwoot/control/routing-context';
 const openapi=JSON.parse(await readFile(resolve(root,'docs/api/openapi.json'),'utf8'));
 const inventory=await buildRouteInventory({rootDirectory:root,openapi});
 const route=inventory.find(item=>item.method==='GET'&&item.path===path);
 expect(route).toMatchObject({authentication:'BOUND_CHATWOOT_CONTROL_KEY',permission:'CHATWOOT_READ',tenantRls:true,
  idempotency:'READ_ONLY_FRESH_BATCH_SNAPSHOT',challengeExposure:'NO_STORE_METADATA_ONLY',
  handlerFile:'apps/api/src/http/routes/chatwoot-control.ts',requestSchemas:['query:integrationIds'],
  ownershipCheck:'RLS_CURRENT_CONTROL_KEY_ACCOUNT_DESTINATION_REVISION_AND_EXACT_INTEGRATION_BINDINGS_RECHECK_BEFORE_AFTER_READ_NO_PROVIDER_IO_NO_WRITES'});
 expect(route.cacheHeaders).toContain('Cache-Control');
 expect(openapi.paths[path].get.security).toEqual([{jrcApiKeyAuth:[]}]);
 const handlerSource=await readFile(resolve(root,route.handlerFile),'utf8');
 expect(handlerSource.split(/\r?\n/u)[route.handlerLine-1]).toContain(`app.get('${path}'`);
 const start=handlerSource.indexOf(`app.get('${path}'`);
 const handler=handlerSource.slice(start,handlerSource.indexOf('\n  });',start));
 expect(handler).toContain("req.authentication?.kind !== 'API_KEY'");
 expect(handler).toContain("options.service.authorize(req.authentication, 'chatwoot:read')");
 expect(handler).toContain('facade().routingContext(');
 const service=await readFile(resolve(root,'apps/api/src/modules/integrations/chatwoot-routing-context.ts'),'utf8');
 expect(service).toContain("p.authentication.kind !== 'API_KEY' || p.restriction");
 const recheck="options.auth.revalidate(tx, p, 'chatwoot:read')";
 expect(service.split(recheck)).toHaveLength(3);
 expect(service.indexOf(recheck)).toBeLessThan(service.indexOf('tx.query<RoutingRow>'));
 expect(service.lastIndexOf(recheck)).toBeGreaterThan(service.indexOf('tx.query<RoutingRow>'));
 expect(service).toContain('WHERE c.organization_id=$1 AND c.id=ANY($2::uuid[])');
 expect(service).toContain('[p.organizationId, ids]');
 expect(service).toContain('rows.length !== ids.length');
 expect(service).toContain('accountId: p.accountId');
 expect(service).toContain('destinationRevision: p.destinationRevision');
 expect(service).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|fetch\s*\(|readIdentity\s*\(|getStatus\s*\()/iu);
 const authorization=await readFile(resolve(root,'apps/api/src/modules/integrations/chatwoot-control-auth.ts'),'utf8');
 expect(authorization).toContain('Number(row.account_id) !== Number(account.account_id)');
 expect(authorization).toContain('row.destination_revision !== destination.revision');
 expect(authorization).toContain('current.accountId !== principal.accountId');
 expect(authorization).toContain('current.destinationRevision !== principal.destinationRevision');
});
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
  ['GET','/v1/partner-webhooks','READ_ONLY'],['POST','/v1/partner-webhooks','TENANT_HASHED_KEY_NORMALIZED_URL_ACK_MODE_EXACT_REPLAY'],
  ['DELETE','/v1/partner-webhooks/{id}','REVOCATION_ONLY_CANCEL_PENDING_AND_LEASED_DELIVERIES'],
  ['GET','/v1/partner-events','READ_ONLY_COMMIT_ORDERED_CURSOR_RETENTION_WATERMARK'],['GET','/v1/partner-webhook-deliveries','READ_ONLY_BOUNDED_DIAGNOSTICS'],
 ]){
  const route=selected(method,path);expect(route).toMatchObject({authentication:'JWT_CURRENT_MEMBERSHIP_OR_CURRENT_ORGANIZATION_API_KEY',permission:'OWNER_ADMIN_OR_WEBHOOKS_MANAGE_SCOPE',tenantRls:true,idempotency,handlerFile:'apps/api/src/http/routes/partner-webhooks.ts'});
  expect(route.handlerLine).toBeGreaterThan(0);expect(route.ownershipCheck).toContain('AUTHENTICATED_TENANT');
  if(method==='POST')expect(route.challengeExposure).toBe('NO_STORE_ENCRYPTED_SIGNING_SECRET_EXACT_AUTHORIZED_REPLAY_ONLY');
 }
});
it('classifies media upload/state/send as key-only with separate scopes and byte/storage boundaries',async()=>{
 const openapi=JSON.parse(await readFile(resolve(root,'docs/api/openapi.json'),'utf8'));
 const inventory=await buildRouteInventory({rootDirectory:root,openapi});
 for(const [method,path,permission] of [
  ['POST','/v1/messaging/channels/{id}/media','MEDIA_UPLOAD_SCOPE'],
  ['GET','/v1/messaging/channels/{id}/media/{mediaId}','MEDIA_UPLOAD_SCOPE'],
  ['POST','/v1/messaging/channels/{id}/partner-media','MESSAGING_SEND_AND_MEDIA_SEND_SCOPES'],
 ]){
  expect(inventory.find(route=>route.method===method&&route.path===path)).toMatchObject({authentication:'CURRENT_ORGANIZATION_API_KEY',permission,tenantRls:true,handlerFile:'apps/api/src/http/routes/messaging.ts'});
 }
});
it('records messaging:read on every existing literal GET guard, including private media',async()=>{
 const openapi=JSON.parse(await readFile(resolve(root,'docs/api/openapi.json'),'utf8'));
 const inventory=await buildRouteInventory({rootDirectory:root,openapi});
 const reads=inventory.filter(route=>route.method==='GET'&&route.path.startsWith('/v1/messaging/')&&!route.path.endsWith('/media/{mediaId}'));
 expect(reads).toHaveLength(9);
 for(const route of reads)expect(route).toMatchObject({authentication:'JWT_CURRENT_MEMBERSHIP_OR_CURRENT_ORGANIZATION_API_KEY',permission:'CURRENT_MEMBER_OR_MESSAGING_READ_SCOPE',tenantRls:true,handlerFile:'apps/api/src/http/routes/messaging.ts'});
 expect(reads.find(route=>route.path==='/v1/messaging/media/{id}').ownershipCheck).toContain('RECHECK_AFTER_PRIVATE_MEDIA_READ');
});
