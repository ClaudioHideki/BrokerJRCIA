// @vitest-environment jsdom
import {fireEvent,render,screen} from '@testing-library/react';
import {useState} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {welcomeFlow} from '@jrc/contracts';
import {FlowCanvas} from './FlowCanvas.js';
afterEach(()=>vi.restoreAllMocks());
function Editor(){const [graph,setGraph]=useState(welcomeFlow());return <FlowCanvas graph={graph} editable onChange={setGraph}/>;}
it('preserves a connected node when removal is not confirmed and supports undo after confirmation',()=>{
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false),label=welcomeFlow().nodes[1]!.label;render(<Editor/>);
 fireEvent.click(screen.getByRole('button',{name:'Configurar '+label}));fireEvent.click(screen.getByRole('button',{name:'Remover bloco'}));
 expect(screen.getByRole('button',{name:'Configurar '+label})).toBeVisible();
 confirm.mockReturnValue(true);fireEvent.click(screen.getByRole('button',{name:'Remover bloco'}));expect(screen.queryByRole('button',{name:'Configurar '+label})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Desfazer'}));expect(screen.getByRole('button',{name:'Configurar '+label})).toBeVisible();
});
it('applies the same confirmation to keyboard deletion without affecting the start node',()=>{
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(true),graph=welcomeFlow();render(<Editor/>);
 fireEvent.keyDown(screen.getByRole('button',{name:'Configurar '+graph.nodes[1]!.label}),{key:'Delete'});
 expect(screen.queryByRole('button',{name:'Configurar '+graph.nodes[1]!.label})).toBeNull();
 fireEvent.keyDown(screen.getByRole('button',{name:'Configurar '+graph.nodes[0]!.label}),{key:'Delete'});
 expect(screen.getByRole('button',{name:'Configurar '+graph.nodes[0]!.label})).toBeVisible();expect(confirm).toHaveBeenCalledTimes(1);
});
