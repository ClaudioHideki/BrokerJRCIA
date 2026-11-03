import {expect,it,vi} from 'vitest';
import type {TenantTransaction} from '../../src/db/tenant-transaction.js';
import {assertHandoffBinding} from '../../src/modules/attendance/handoff-binding.js';
const root='11111111-1111-4111-8111-111111111111',child='22222222-2222-4222-8222-222222222222';
const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const graph=(subflow=false,version=3)=>({nodes:[node('start','start'),subflow?node('capture','subflow',{automationId:child,version:1}):node('capture','input',{inputConfigVersion:version,inputType:version===3?'image':'text',variable:'attachment',maxAttempts:2}),node('end','end')],edges:[{id:'a',source:'start',target:'capture',port:'next'},{id:'b',source:'capture',target:'end',port:'next'}]});
function tx(transport:string,subflow=false,version=3){const query=vi.fn(async(sql:string,args:unknown[])=>({rows:sql.includes('automation_versions')?[{graph:graph(subflow&&args[1]===root,version)}]:[{transport}]}));return{query,transaction:{query} as unknown as TenantTransaction};}
it.each([false,true])('admits the implemented central attachment capture at the common binding boundary (nested=%s)',async nested=>{
 const t=tx('CENTRAL_TRANSPORT',nested);await expect(assertHandoffBinding(t.transaction,root,child,root,1)).resolves.toBeUndefined();
 const unknown=tx('UNSUPPORTED',nested);await expect(assertHandoffBinding(unknown.transaction,root,child,root,1)).rejects.toMatchObject({code:'AUTOMATION_INPUT_MEDIA_TRANSPORT_UNSUPPORTED'});
});
it('permits physical channels without changing the owner, media state or remote binding',async()=>{
 const t=tx('BROKER_TRANSPORT');await expect(assertHandoffBinding(t.transaction,root,child,root,1)).resolves.toBeUndefined();
 expect(t.query.mock.calls.every(([sql])=>sql.startsWith('SELECT'))).toBe(true);
});
it('does not add a media capability lookup to existing text capture versions',async()=>{
 const t=tx('CENTRAL_TRANSPORT',false,2);await expect(assertHandoffBinding(t.transaction,root,child,root,1)).resolves.toBeUndefined();
 expect(t.query.mock.calls.every(([sql])=>sql.includes('automation_versions'))).toBe(true);
});
