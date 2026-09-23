import { describe, expect, it, vi } from 'vitest';
import { welcomeFlow } from '@jrc/contracts';
import { createAutomationService } from '../../src/modules/automations/service.js';
import type { AutomationRepository } from '../../src/modules/automations/repository.js';

describe('editable automation drafts', () => {
  const graph = () => ({ ...welcomeFlow(), edges: [] });
  function setup() {
    const row = { id:'draft', organizationId:'tenant-a', name:'Importação', lifecycleStatus:'DRAFT',
      draftGraph:graph(), draftRevision:1, activeVersion:null, updatedAt:new Date() };
    const repository = { insertDefinition:vi.fn().mockResolvedValue(row), updateDefinition:vi.fn().mockResolvedValue(row),
      getDefinition:vi.fn().mockResolvedValue(row), insertVersion:vi.fn() } as unknown as AutomationRepository;
    return { repository, service:createAutomationService({ repository, transact:async (_org, work) => work({} as never) }) };
  }
  it('stores structurally valid but incomplete imports as editable drafts', async () => {
    const {service, repository} = setup();
    await expect(service.create('tenant-a',{name:'Importação',graph:graph()})).resolves.toMatchObject({lifecycleStatus:'DRAFT'});
    expect(repository.insertDefinition).toHaveBeenCalled();
  });
  it('saves work in progress without requiring publication validity', async () => {
    const {service} = setup();
    await expect(service.save('tenant-a','draft',{name:'Importação',graph:graph(),revision:1})).resolves.toMatchObject({draft:{revision:1}});
  });
  it('still blocks publication and simulation of an incomplete graph', async () => {
    const {service, repository} = setup();
    await expect(service.publish('tenant-a','draft',1)).rejects.toMatchObject({code:'AUTOMATION_INVALID'});
    await expect(service.simulate('tenant-a','draft',{text:'Teste'})).rejects.toMatchObject({code:'AUTOMATION_INVALID'});
    expect(repository.insertVersion).not.toHaveBeenCalled();
  });
  it('rejects malformed graph structures before persisting', async () => {
    const {service, repository} = setup();
    await expect(service.create('tenant-a',{name:'Inválido',graph:{nodes:'invalid'} as never})).rejects.toThrow();
    expect(repository.insertDefinition).not.toHaveBeenCalled();
  });
});
