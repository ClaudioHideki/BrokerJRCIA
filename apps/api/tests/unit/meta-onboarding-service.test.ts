import { it, expect, vi } from 'vitest';
import { createMetaOnboardingService } from '../../src/modules/meta-onboarding/service.js';
it('consumes state before exchanging code and rejects cross tenant or replay without Graph calls', async () => {
 const query=vi.fn().mockResolvedValue({rows:[],rowCount:0});
 const graph={authorize:vi.fn(),subscribe:vi.fn(),checkReadiness:vi.fn(),register:vi.fn()};
 const service=createMetaOnboardingService({environment:{META_APP_ID:'123',META_APP_SECRET:'private',META_SIGNUP_CONFIG_ID:'456',META_GRAPH_VERSION:'v25.0',META_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32).toString('base64')},
   transact:async (_org,operation)=>operation({query} as never),graph});
 await expect(service.complete('org-b','user',{state:'x'.repeat(43),code:'code',wabaId:'12345',phoneNumberId:'67890'})).rejects.toMatchObject({status:409});
 expect(graph.authorize).not.toHaveBeenCalled();
 expect(query.mock.calls[0]?.[1]).toContain('org-b');
 expect(query.mock.calls[0]?.[1]).toContain('user');
});
