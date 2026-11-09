// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {NativeBoxRouting} from './BoxRouting.js';
import {getBoxRouting,saveBoxRouting} from '../automations/box-routing-api.js';
vi.mock('../automations/box-routing-api.js',()=>({getBoxRouting:vi.fn(),saveBoxRouting:vi.fn()}));
const org='11111111-1111-4111-8111-111111111111',channel='22222222-2222-4222-8222-222222222222',automation='33333333-3333-4333-8333-333333333333';
afterEach(()=>{cleanup();vi.resetAllMocks();});
function fixture(){
 const value={routes:[{routeKey:'sales',labels:{pt:'Comercial',en:'Sales'},mode:'AGENT'}],
  catalog:{teams:[{id:10,name:'Comercial'}]},teamMembers:[{teamId:10,agents:[{id:1,name:'Ana'}]}],profile:null};
 vi.mocked(getBoxRouting).mockResolvedValue(value as never);
 vi.mocked(saveBoxRouting).mockResolvedValue({revision:1} as never);
 const client={request:vi.fn()} as any;
 return {client,element:(editable=true,c=channel)=><NativeBoxRouting client={client} organizationId={org} automationId={automation} channelId={c} version={1} editable={editable}/>};
}
it('saves the selected department and agents with CAS without activating ownership',async()=>{
 const h=fixture();render(h.element());
 fireEvent.change(await screen.findByLabelText('Time de Comercial'),{target:{value:'10'}});
 await waitFor(()=>expect(getBoxRouting).toHaveBeenCalledWith(h.client,org,automation,1,channel,10));
 fireEvent.change(screen.getByLabelText('Atendentes de Comercial'),{target:{value:'SELECTED'}});
 fireEvent.click(screen.getByLabelText('Ana'));
 fireEvent.click(screen.getByRole('button',{name:'Salvar atendimento da caixa'}));
 await waitFor(()=>expect(saveBoxRouting).toHaveBeenCalledWith(h.client,org,automation,1,channel,0,{schemaVersion:1,routes:[{routeKey:'sales',teamId:10,mode:'AGENT',membership:'SELECTED',agentIds:[1]}]}));
 expect(h.client.request).not.toHaveBeenCalled();
});
it('does not permit a read-only session to mutate the routing profile',async()=>{
 const h=fixture();render(h.element(false));
 expect(await screen.findByRole('button',{name:'Salvar atendimento da caixa'})).toBeDisabled();
 expect(screen.getByLabelText('Time de Comercial')).toBeDisabled();
 expect(saveBoxRouting).not.toHaveBeenCalled();
});
