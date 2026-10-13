// @vitest-environment jsdom
import {describe,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {CredentialsPage} from '../pages/Credentials.js';
const {request,client}=vi.hoisted(()=>{const request=vi.fn();return{request,client:{request}};});
vi.mock('../auth/SessionProvider.js',()=>({useApiClient:()=>client,useSession:()=>({session:{activeOrganization:{role:'OWNER'}}})}));
describe('HTTP credential creation by name',()=>{
 it('submits friendly authentication and separate origins without asking for JSON or an ID',async()=>{
  request.mockResolvedValue({data:[]});render(<CredentialsPage/>);fireEvent.click(screen.getByText('Nova credencial'));
  fireEvent.change(screen.getByLabelText('Nome'),{target:{value:'ERP'}});fireEvent.change(screen.getByLabelText('Token da credencial'),{target:{value:'synthetic-secret'}});
  fireEvent.change(screen.getByLabelText(/^Destinos HTTPS permitidos/u),{target:{value:'https://api.example.test\nhttps://other.example.test'}});
  fireEvent.click(screen.getByRole('button',{name:'Salvar credencial'}));await waitFor(()=>expect(request.mock.calls.some(([path,init])=>path==='/v1/credentials'&&init?.method==='POST')).toBe(true));
  const [,init]=request.mock.calls.find(([path,init])=>path==='/v1/credentials'&&init?.method==='POST')!;expect(JSON.parse(init.body)).toEqual({name:'ERP',type:'BEARER',secret:{token:'synthetic-secret'},metadata:{allowedOrigins:['https://api.example.test','https://other.example.test']}});
  await waitFor(()=>expect(screen.getByLabelText('Token da credencial')).toHaveValue(''));expect(screen.queryByLabelText('Segredo em JSON')).not.toBeInTheDocument();
 });
});
