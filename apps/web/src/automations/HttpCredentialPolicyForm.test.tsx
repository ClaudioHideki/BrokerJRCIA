// @vitest-environment jsdom
import {describe,it,expect,vi} from 'vitest';
import {render,screen,fireEvent} from '@testing-library/react';
import {HttpCredentialPolicyForm} from './HttpCredentialPolicyForm.js';
describe('HTTP credential destination configuration',()=>{
 it('lets the administrator configure allowed origins without reading or rotating a secret',()=>{
  const save=vi.fn();render(<HttpCredentialPolicyForm name="ERP" allowedOrigins={[]} disabled={false} onSave={save}/>);
  fireEvent.change(screen.getByLabelText('Destinos HTTPS permitidos para ERP'),{target:{value:'https://api.example.test\nhttps://other.example.test'}});fireEvent.click(screen.getByRole('button',{name:'Salvar destinos permitidos'}));expect(save).toHaveBeenCalledWith(['https://api.example.test','https://other.example.test']);expect(screen.queryByLabelText(/token|segredo|UUID/i)).not.toBeInTheDocument();
 });
 it('keeps read-only policy intact',()=>{
  const save=vi.fn();render(<HttpCredentialPolicyForm name="ERP" allowedOrigins={['https://api.example.test']} disabled={true} onSave={save}/>);expect(screen.getByRole('button',{name:'Salvar destinos permitidos'})).toBeDisabled();expect(save).not.toHaveBeenCalled();
 });
 it('rejects private, insecure and path-qualified origins without dispatching policy changes',()=>{
  const save=vi.fn();render(<HttpCredentialPolicyForm name="ERP" allowedOrigins={[]} disabled={false} onSave={save}/>);
  for(const value of ['https://localhost','http://api.example.test','https://api.example.test/path']){fireEvent.change(screen.getByLabelText('Destinos HTTPS permitidos para ERP'),{target:{value}});expect(screen.getByRole('button',{name:'Salvar destinos permitidos'})).toBeDisabled();expect(screen.getByRole('alert')).toHaveTextContent('destinos HTTPS públicos');}expect(save).not.toHaveBeenCalled();
 });
});
