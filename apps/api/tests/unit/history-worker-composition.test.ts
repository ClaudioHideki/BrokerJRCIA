import {expect,it,vi} from 'vitest';
const ports=vi.hoisted(()=>({run:vi.fn(async()=>({kind:'IDLE'})),end:vi.fn(async()=>{}),pool:vi.fn(),integration:vi.fn(),v2:vi.fn(),fleet:{}}));
vi.mock('pg',()=>({Pool:class{constructor(options:unknown){ports.pool(options);}query=async()=>({rows:[{organization_id:'synthetic-organization'}]});end=ports.end;}}));
vi.mock('../../src/modules/integrations/runtime.js',()=>({createIntegrationRuntime:ports.integration}));
vi.mock('../../src/modules/history-sync/runtime.js',()=>({createHistorySyncRuntime:ports.v2}));
vi.mock('../../src/modules/evolution-fleet/runtime.js',()=>({createEvolutionFleetRuntime:()=>ports.fleet}));
import {runHistoryImportWorker} from '../../src/commands/history-import-worker.js';
it('runs V2 with the existing two-connection worker pool and no legacy source database',async()=>{
 vi.clearAllMocks();ports.integration.mockReturnValue({fleet:ports.fleet});ports.v2.mockResolvedValue({runOnce:ports.run});
 await runHistoryImportWorker({DATABASE_URL:'postgres://jrc_app@127.0.0.1:1/synthetic',HISTORY_SYNC_V2_ENABLED:'true'});
 expect(ports.pool).toHaveBeenCalledTimes(1);expect(ports.pool).toHaveBeenCalledWith(expect.objectContaining({max:2}));
 expect(ports.run).toHaveBeenCalledWith('synthetic-organization');expect(ports.end).toHaveBeenCalledOnce();
});
it('keeps the new integration/driver unconstructed when the additive gate is off',async()=>{
 vi.clearAllMocks();
 await runHistoryImportWorker({DATABASE_URL:'postgres://jrc_app@127.0.0.1:1/synthetic'});
 expect(ports.integration).not.toHaveBeenCalled();expect(ports.v2).not.toHaveBeenCalled();expect(ports.run).not.toHaveBeenCalled();
});
