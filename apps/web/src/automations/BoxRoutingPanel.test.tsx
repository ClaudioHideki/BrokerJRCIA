// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {MemoryRouter} from 'react-router';
import {BoxRoutingPanel} from './BoxRoutingPanel.js';
import {getBoxRouting,saveBoxRouting} from './box-routing-api.js';
import {listChannels,getChannelAutomation} from '../channels/api.js';
vi.mock('./box-routing-api.js',()=>({getBoxRouting:vi.fn(),saveBoxRouting:vi.fn()}));
vi.mock('../channels/api.js',()=>({listChannels:vi.fn(),getChannelAutomation:vi.fn()}));
const org='11111111-1111-4111-8111-111111111111',channel='22222222-2222-4222-8222-222222222222',automation='33333333-3333-4333-8333-333333333333';
const item={id:automation,name:'URA reutilizável',activeVersion:1,lifecycleStatus:'PUBLISHED',draft:{revision:1,graph:{nodes:[],edges:[]}}} as never;
function setup(){
 vi.mocked(listChannels).mockResolvedValue({data:[{id:channel,organizationId:org,identity:{displayName:'WhatsApp Comercial',maskedAddress:'****0000'},destination:{name:'Atendimento',inboxId:20},transportStatus:'CONNECTED'}],nextCursor:null} as never);
 vi.mocked(getChannelAutomation).mockResolvedValue({binding:null,ownerRevision:0});
 vi.mocked(getBoxRouting).mockResolvedValue({routes:[{routeKey:'sales',labels:{pt:'Comercial',en:'Sales'},mode:'AGENT'}],
  catalog:{scope:{organizationId:org,channelId:channel,accountId:1,inboxId:20},teams:[{id:10,name:'Comercial',autoAssignment:false}],inboxPolicy:{greetingEnabled:false,autoAssignmentEnabled:false},capabilities:{agentBot:'SUPPORTED'},remoteBot:null},
  teamMembers:[{teamId:10,agents:[{id:1,name:'Ana'},{id:2,name:'Bruno'}]}],profile:null,rulesCheck:'UNVERIFIED'} as never);
 vi.mocked(saveBoxRouting).mockResolvedValue({revision:1} as never);
 const client={request:vi.fn(async()=>({status:'ACTIVE'}))} as any;
 return {client,element:(o=org,editable=true)=><MemoryRouter><BoxRoutingPanel client={client} organizationId={o} items={[item]} editable={editable} initialChannel={channel}/></MemoryRouter>};
}
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('configures a department and activates the selected box from Flow with real-name preview and revisions',async()=>{
 const h=setup();render(h.element());
 fireEvent.change(await screen.findByLabelText('Automação para esta caixa'),{target:{value:automation}});
 const team=await screen.findByLabelText('Time JRC — Comercial');fireEvent.change(team,{target:{value:'10'}});
 expect(screen.getByText('1 - Ana')).toBeInTheDocument();expect(screen.getByText('2 - Bruno')).toBeInTheDocument();
 expect(screen.getByText(/Novos membros elegíveis/)).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Salvar atendimento da caixa'}));
 await waitFor(()=>expect(saveBoxRouting).toHaveBeenCalledWith(h.client,org,automation,1,channel,0,{schemaVersion:1,routes:[{routeKey:'sales',teamId:10,mode:'AGENT',membership:'ALL',agentIds:[]}]}));
 fireEvent.click(await screen.findByRole('button',{name:'Ativar nesta caixa'}));
 await waitFor(()=>expect(h.client.request).toHaveBeenCalledWith(`/v1/automations/${automation}/bindings`,expect.objectContaining({method:'POST',body:JSON.stringify({channelId:channel,version:1,expectedOwnerRevision:0,expectedProfileRevision:1})})));
 expect(await screen.findByText(/Novas entradas ativadas/)).toBeInTheDocument();
});
it('does not fetch configuration for agents and drops late tenant responses',async()=>{
 const h=setup(),view=render(h.element(org,false));expect(getBoxRouting).not.toHaveBeenCalled();expect(listChannels).not.toHaveBeenCalled();
 view.rerender(h.element());await screen.findByLabelText('Automação para esta caixa');
 let finish!:(v:any)=>void;vi.mocked(getBoxRouting).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
 fireEvent.change(screen.getByLabelText('Automação para esta caixa'),{target:{value:automation}});
 await waitFor(()=>expect(getBoxRouting).toHaveBeenCalled());view.rerender(h.element('44444444-4444-4444-8444-444444444444'));
 finish({routes:[{routeKey:'secret',labels:{pt:'Outro cliente',en:'Other'},mode:'AGENT'}]});
 await waitFor(()=>expect(screen.queryByText('Outro cliente')).not.toBeInTheDocument());
});
it('blocks activation after a failed refresh rather than reusing an earlier owner revision',async()=>{
 const h=setup();render(h.element());fireEvent.change(await screen.findByLabelText('Automação para esta caixa'),{target:{value:automation}});
 fireEvent.change(await screen.findByLabelText('Time JRC — Comercial'),{target:{value:'10'}});
 fireEvent.click(screen.getByRole('button',{name:'Salvar atendimento da caixa'}));await screen.findByRole('status');
 expect(screen.getByRole('button',{name:'Ativar nesta caixa'})).toBeEnabled();
 vi.mocked(getChannelAutomation).mockRejectedValueOnce(Error('protected payload'));
 fireEvent.click(screen.getByRole('button',{name:'Atualizar destinos e vínculo'}));await screen.findByRole('alert');
 expect(screen.getByRole('button',{name:'Ativar nesta caixa'})).toBeDisabled();expect(screen.queryByText('protected payload')).toBeNull();
});
it('keeps a first-setup form after refresh even before a profile has been saved',async()=>{
 const h=setup();render(h.element());fireEvent.change(await screen.findByLabelText('Automação para esta caixa'),{target:{value:automation}});
 await screen.findByLabelText('Time JRC — Comercial');fireEvent.click(screen.getByRole('button',{name:'Atualizar destinos e vínculo'}));
 await waitFor(()=>expect(getBoxRouting).toHaveBeenCalledTimes(2));expect(screen.getByLabelText('Time JRC — Comercial')).toBeVisible();
});
it('fences resume by the active profile revision and disables it while local configuration is dirty',async()=>{
 const h=setup(),base=await vi.mocked(getBoxRouting).getMockImplementation()!(h.client,org,automation,1,channel);
 vi.mocked(getBoxRouting).mockResolvedValue({...base,profile:{revision:2,activeRevision:1,config:{schemaVersion:1,routes:[{routeKey:'sales',teamId:10,mode:'AGENT',membership:'ALL',agentIds:[]}]}}} as never);
 vi.mocked(getChannelAutomation).mockResolvedValue({binding:{id:automation,automationId:automation,version:1,revision:7,status:'PAUSED'},ownerRevision:3} as never);
 render(h.element());fireEvent.change(await screen.findByLabelText('Automação para esta caixa'),{target:{value:automation}});
 const resume=await screen.findByRole('button',{name:'Retomar novas entradas'});fireEvent.click(resume);
 await waitFor(()=>expect(h.client.request).toHaveBeenCalledWith(`/v1/automations/${automation}/bindings/${automation}`,expect.objectContaining({body:JSON.stringify({status:'ACTIVE',revision:7,expectedOwnerRevision:3,expectedProfileRevision:1})})));
 fireEvent.change(screen.getByLabelText('Atendentes — Comercial'),{target:{value:'SELECTED'}});expect(resume).toBeDisabled();
});
