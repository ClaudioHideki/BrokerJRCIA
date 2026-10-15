import {beforeEach,describe,expect,it,vi} from 'vitest';
const fixture=vi.hoisted(()=>({qr:false,scope:'synthetic-fleet-scope',end:vi.fn(async()=>undefined)}));
vi.mock('pg',()=>({Pool:class{end=fixture.end;}}));
vi.mock('../../src/modules/integrations/runtime.js',()=>({loadIntegrationConfig:()=>fixture.qr?{qr:{webhookOrigin:'https://broker.example.test'}}:{}}));
vi.mock('../../src/modules/evolution-fleet/runtime.js',()=>({createEvolutionFleetRuntime:()=>({configurationScope:()=>fixture.scope})}));
vi.mock('../../src/modules/automations/repository.js',()=>({createPostgresAutomationRepository:vi.fn(()=>({}))}));
vi.mock('../../src/modules/automations/service.js',()=>({createExecutionService:()=>({releaseDueWaits:vi.fn()})}));
vi.mock('../../src/commands/automation-worker.js',()=>({scanOperationalOrganizations:vi.fn(async()=>undefined)}));
import {createPostgresAutomationRepository} from '../../src/modules/automations/repository.js';
import {runSchedulerWorker} from '../../src/commands/scheduler-worker.js';
beforeEach(()=>{fixture.qr=false;vi.clearAllMocks();});
describe('scheduler capture authority composition',()=>{
  it('keeps the restrictive default when group configuration is absent',async()=>{
    await runSchedulerWorker({DATABASE_URL:'postgresql://jrc_app@localhost/synthetic'});
    expect(vi.mocked(createPostgresAutomationRepository).mock.calls[0]?.[0]).toBeUndefined();
  });
  it('passes the configured encryption key and canonical fleet scope to its repository',async()=>{
    fixture.qr=true;const key=Buffer.alloc(32,4).toString('base64');
    await runSchedulerWorker({DATABASE_URL:'postgresql://jrc_app@localhost/synthetic',INTEGRATION_ENCRYPTION_KEY:key});
    expect(createPostgresAutomationRepository).toHaveBeenCalledWith({encryptionKey:key,configurationScope:fixture.scope});
  });
});
