import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {expect,it} from 'vitest';
import {buildRouteInventory} from '../scripts/security/inventory-routes.mjs';

it('documents both progress reads with exact channel or current Control/inbox authorization and no write or replay',async()=>{
  const root=resolve(import.meta.dirname,'..'),openapi=JSON.parse(await readFile(resolve(root,'docs/api/openapi.json'),'utf8'));
  const inventory=await buildRouteInventory({rootDirectory:root,openapi});
  for(const [path,authentication,permission] of [
    ['/v1/channels/{id}/history-sync/v2/progress','JWT_CURRENT_MEMBERSHIP','OWNER_ADMIN_OPERATOR'],
    ['/v1/integrations/chatwoot/control/connections/{integrationId}/history-sync/v2/progress','JWT_OR_BOUND_CONTROL_KEY','CURRENT_MEMBERSHIP_OR_CHATWOOT_READ'],
  ]) {
    const route=inventory.find(value=>value.path===path&&value.method==='GET');
    expect(route).toMatchObject({authentication,permission,tenantRls:true,idempotency:'READ_ONLY',challengeExposure:'NO_STORE_METADATA_ONLY'});
    expect(route.ownershipCheck).toContain('NO_SOURCE_ADMISSION_OR_REPLAY');
    expect(route.handlerLine).toBeGreaterThan(0);
    expect(openapi.paths[path].get.responses['200']).toBeDefined();
  }
});
