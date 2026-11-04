// @vitest-environment jsdom
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {MemoryRouter,Routes,Route} from 'react-router';
import {expect,it,vi} from 'vitest';
import {NativeNewFlow} from './workspace.js';
import type {ApiClient} from '../api/client.js';

it('creates the explicitly partial OIA draft in the embedded Conversas editor, without activation',async()=>{
  const request=vi.fn(async()=>({id:'draft-oia'}));
  render(<MemoryRouter><Routes><Route path="/" element={<NativeNewFlow client={{request} as unknown as ApiClient} canEdit/>}/><Route path="/automations/:id/edit" element={<p>Editor aberto</p>}/></Routes></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Modelo inicial'),{target:{value:'OIA_VISUAL_HML'}});
  expect(screen.getByText(/Horários e nomes iniciais são dados de teste/)).toBeVisible();
  fireEvent.change(screen.getByLabelText('Nome'),{target:{value:'OIA — RECONSTRUÇÃO VISUAL HML — PARIDADE PARCIAL'}});
  fireEvent.click(screen.getByRole('button',{name:'Criar rascunho e abrir editor'}));
  await waitFor(()=>expect(request).toHaveBeenCalledTimes(1));
  const [path,init]=request.mock.calls[0] as unknown as [string,RequestInit];expect(path).toBe('/v1/automations');
  const body=JSON.parse(String(init.body));expect(body.graph.nodes.filter((n:{type:string})=>n.type==='handoff')).toHaveLength(13);
  expect(body.graph.nodes.find((n:{id:string})=>n.id==='start').data.reentry).toBe('ONCE_PER_CONVERSATION');
  expect(await screen.findByText('Editor aberto')).toBeVisible();
});
