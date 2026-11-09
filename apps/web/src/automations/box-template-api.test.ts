import {it,expect,vi} from 'vitest';
import {oiaVisualReconstructionFlow} from '@jrc/contracts';
import {prepareBoxTemplateDraft} from './box-template-api.js';
it('prepares an unbound draft import for explicit conversion without publishing or modifying the original',async()=>{
 const org='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',graph=oiaVisualReconstructionFlow();
 const original={schemaVersion:1,id,organizationId:org,name:'OIA importada',lifecycleStatus:'DRAFT',activeVersion:null,draft:{revision:1,graph},updatedAt:'2030-01-01T00:00:00Z'};
 const encoded=JSON.stringify(original),request=vi.fn(async()=>original),result=await prepareBoxTemplateDraft({request} as never,org,id);
 expect(result.graph.nodes.some(n=>n.type==='directory-menu')).toBe(true);expect(JSON.stringify(original)).toBe(encoded);
 expect(request).toHaveBeenCalledTimes(1);expect(request).toHaveBeenCalledWith(`/v1/automations/${id}`);
 await expect(prepareBoxTemplateDraft({request} as never,'33333333-3333-4333-8333-333333333333',id)).rejects.toThrow();
});
