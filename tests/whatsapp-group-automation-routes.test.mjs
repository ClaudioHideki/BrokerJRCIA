import {readFile} from 'node:fs/promises';
import {expect,it} from 'vitest';
import {handlerLine,buildRouteInventory} from '../scripts/security/inventory-routes.mjs';
import {createOpenApiDocument} from '../apps/api/src/http/openapi.js';
const paths=[['get',''],['put',''],['post','/pause'],['post','/resume'],['post','/dispatch-attempts/{attemptId}/abandon'],['post','/observations/{observationId}/abandon']];
it('exposes every GROUP operation with a literal source handler and explicit authenticated OpenAPI schema',async()=>{
  const source=await readFile('apps/api/src/http/routes/whatsapp-groups.ts','utf8');
  const doc=await createOpenApiDocument();
  const inventory=await buildRouteInventory({rootDirectory:process.cwd(),openapi:doc});
  for(const[method,suffix]of paths){
    const path='/v1/channels/{id}/whatsapp-group-automation'+suffix;
    expect(handlerLine(source,method.toUpperCase(),path)).toBeGreaterThan(0);
    expect(doc.paths[path]?.[method]).toMatchObject({security:expect.any(Array),responses:{200:expect.any(Object)}});
    expect(doc.paths[path]?.[method].security.length).toBeGreaterThan(0);
    expect(inventory.find(item=>item.path===path&&item.method===method.toUpperCase())).toMatchObject({tenantRls:true,authentication:'JWT_CURRENT_MEMBERSHIP',permission:method==='get'?'OWNER_ADMIN_OPERATOR':'OWNER_ADMIN'});
  }
},60000);
