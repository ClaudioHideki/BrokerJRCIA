import {expect,it,vi} from 'vitest';
import * as runtime from '../../src/modules/flows/delegation/runtime.js';
it('wraps only the existing auth-role credential function and validates digest before query',async()=>{
 const org='aaaa1111-1111-4111-8111-111111111111',query=vi.fn(async()=>({rows:[{organization_id:org}]}));
 const resolver=runtime.createFlowCredentialResolver({query} as never);
 expect(await resolver('invalid')).toBeNull();expect(query).not.toHaveBeenCalled();
 expect(await resolver('a'.repeat(64))).toBe(org);
 expect(query).toHaveBeenCalledExactlyOnceWith('SELECT resolve_flow_delegation_credential($1) AS organization_id',['a'.repeat(64)]);
 query.mockResolvedValueOnce({rows:[]} as never);expect(await resolver('b'.repeat(64))).toBeNull();
});
