import {describe,it,expect,vi} from 'vitest';
import {assertHttpQueryPolicies,readHttpCredentialCatalog} from '../../src/modules/automations/http-query-policy.js';
import type {TenantTransaction} from '../../src/db/tenant-transaction.js';
const org='11111111-1111-4111-8111-111111111111',root='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
const config={httpConfigVersion:1,method:'GET',url:'https://api.example.test/lookup',credentialId:id,credentialRevision:3,queryParameters:{},target:'result',timeoutMs:5000,maxResponseBytes:32768,retryAttempts:0};
const published={automationId:root,version:1,runtimeStateVersion:2 as const,graph:{nodes:[{id:'query',type:'http',label:'Consultar',position:{x:0,y:0},data:config}],edges:[]}};
const snapshot={root:published,resolve:async()=>published};
const row={id,organizationId:org,name:'ERP',type:'BEARER',revision:3,status:'ACTIVE',allowedOrigins:['https://api.example.test']};
const tx=(rows:unknown[])=>({query:vi.fn().mockResolvedValue({rows})} as unknown as TenantTransaction);
describe('HTTP publication credential policy',()=>{
 it('checks current metadata with tenant and shared lock without reading encrypted secrets',async()=>{
  const db=tx([row]);await assertHttpQueryPolicies(db,org,snapshot);
  const [sql,params]=vi.mocked(db.query).mock.calls[0]!;expect(sql).toContain('for share');expect(sql).toContain('organization_id=$1');expect(sql).not.toMatch(/encrypted_secret|fingerprint/);expect(params).toEqual([org,id]);
 });
 it.each([{rows:[]},{rows:[{...row,organizationId:root}]},{rows:[{...row,status:'REVOKED'}]},{rows:[{...row,type:'POSTGRES'}]},{rows:[{...row,revision:4}]},{rows:[{...row,allowedOrigins:[]}]},{rows:[{...row,allowedOrigins:['https://other.test']}]}])('rejects a missing/stale/cross-tenant/disallowed credential $rows',async ({rows})=>{
  await expect(assertHttpQueryPolicies(tx(rows),org,snapshot)).rejects.toThrow(/^AUTOMATION_HTTP_/);
 });
 it('checks HTTP nodes inside pinned children and leaves historical unmarked nodes alone',async()=>{
  const db=tx([row]),parent={...published,graph:{nodes:[{id:'call',type:'subflow',label:'Filho',position:{x:0,y:0},data:{automationId:id,version:7}}],edges:[]}};
  await assertHttpQueryPolicies(db,org,{root:parent,resolve:async(a,v)=>({...published,automationId:a,version:v})});expect(db.query).toHaveBeenCalledTimes(1);
  const historical={...published,graph:{...published.graph,nodes:published.graph.nodes.map(n=>({...n,data:{method:'POST',url:config.url}}))}};
  await assertHttpQueryPolicies(tx([]),org,{root:historical,resolve:async()=>historical});
 });
 it('pages a metadata-only catalog without truncating or exposing unrelated metadata',async()=>{
  const db=tx([{...row,extra:'secret',allowedOrigins:row.allowedOrigins},{...row,id:root}]);
  const page=await readHttpCredentialCatalog(db,org,root,{pageSize:1});expect(page.data).toEqual([{id,name:'ERP',type:'BEARER',revision:3,allowedOrigins:row.allowedOrigins}]);expect(page.nextCursor).toBeTruthy();expect(JSON.stringify(page)).not.toContain('secret');
  const [sql,params]=vi.mocked(db.query).mock.calls[0]!;expect(sql).not.toMatch(/encrypted_secret|fingerprint/);expect(sql).toContain('limit');expect((params as unknown as unknown[]).at(-1)).toBe(2);
  await expect(readHttpCredentialCatalog(tx([]),root,root,{cursor:page.nextCursor!})).rejects.toThrow('AUTOMATION_HTTP_CURSOR_INVALID');
 });
});
