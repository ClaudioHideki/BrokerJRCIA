// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen} from '@testing-library/react';
import {MemoryRouter} from 'react-router';
import {CompanyPage} from './Company.js';
const fixture=vi.hoisted(()=>({request:vi.fn(),id:'a'}));
vi.mock('../auth/SessionProvider.js',()=>({useApiClient:()=>fixture,useSession:()=>({tenantRevision:1,session:{activeOrganization:{id:fixture.id,name:fixture.id}}})}));
afterEach(()=>{cleanup();fixture.request.mockReset();fixture.id='a';});
it('ignores a deferred source-company response after switching company',async()=>{
 let finish!: (value:unknown)=>void;const pending=new Promise(resolve=>{finish=resolve;});
 const data={status:'ACTIVE',maxInstances:5,maxUsers:10,messagesPerDay:1000,maxPendingMessages:1000,messagesAcceptedToday:2};
 fixture.request.mockImplementation(()=>fixture.id==='a'?pending:Promise.resolve(data));
 const view=render(<MemoryRouter><CompanyPage/></MemoryRouter>);
 fixture.id='b';view.rerender(<MemoryRouter><CompanyPage/></MemoryRouter>);
 expect(await screen.findByText('2 / 1000')).toBeVisible();
 await act(async()=>finish({...data,messagesAcceptedToday:99}));
 expect(screen.queryByText('99 / 1000')).not.toBeInTheDocument();
 expect(screen.getByText('2 / 1000')).toBeVisible();
});
