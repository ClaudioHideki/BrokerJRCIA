// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { welcomeFlow } from '@jrc/contracts';
import { FlowCanvas } from './FlowCanvas.js';

describe('imported graph viewport', () => {
  function Editor(){const [graph,setGraph]=useState(welcomeFlow);return <FlowCanvas graph={graph} editable onChange={setGraph}/>;}
  const capture=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'setPointerCapture');
  const release=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'releasePointerCapture');
  beforeEach(()=>{
    vi.stubGlobal('PointerEvent',MouseEvent);
    HTMLElement.prototype.setPointerCapture=()=>{};
    HTMLElement.prototype.releasePointerCapture=()=>{};
  });
  afterEach(()=>{vi.unstubAllGlobals();for(const [key,descriptor] of [['setPointerCapture',capture],['releasePointerCapture',release]] as const){if(descriptor)Object.defineProperty(HTMLElement.prototype,key,descriptor);else Reflect.deleteProperty(HTMLElement.prototype,key);}});
  it('pans the empty canvas without editing node coordinates, including in read-only mode',()=>{
    const graph=welcomeFlow(),change=vi.fn();
    const {container}=render(<FlowCanvas graph={graph} editable={false} onChange={change}/>);
    const viewport=container.querySelector('.flows-canvas-scroll')!,canvas=container.querySelector('.flows-canvas') as HTMLElement;
    const before=canvas.style.transform;
    fireEvent.pointerDown(viewport,{button:0,clientX:100,clientY:100});
    fireEvent.pointerMove(viewport,{clientX:180,clientY:140});
    fireEvent.pointerUp(viewport);
    expect(canvas.style.transform).not.toBe(before);
    expect(change).not.toHaveBeenCalled();
    const after=canvas.style.transform;
    fireEvent.pointerMove(viewport,{clientX:240,clientY:200});
    expect(canvas.style.transform).toBe(after);
  });
  it('zooms with the wheel around the mouse without changing the graph',()=>{
    const change=vi.fn();
    const {container}=render(<FlowCanvas graph={welcomeFlow()} editable onChange={change}/>);
    const viewport=container.querySelector('.flows-canvas-scroll')!,canvas=container.querySelector('.flows-canvas') as HTMLElement;
    const before=canvas.style.transform;
    const allowed=fireEvent.wheel(viewport,{deltaY:-100,clientX:200,clientY:180,cancelable:true});
    expect(allowed).toBe(false);
    expect(canvas.style.transform).not.toBe(before);
    const parse=(transform:string)=>transform.match(/-?[\d.]+/g)!.map(Number);
    const [oldX,oldY,oldScale]=parse(before),[newX,newY,newScale]=parse(canvas.style.transform);
    expect((200-newX!)/newScale!).toBeCloseTo((200-oldX!)/oldScale!);
    expect((180-newY!)/newScale!).toBeCloseTo((180-oldY!)/oldScale!);
    expect(change).not.toHaveBeenCalled();
  });
  it('stops panning when the pointer is cancelled',()=>{
    const {container}=render(<FlowCanvas graph={welcomeFlow()} editable onChange={vi.fn()}/>);
    const viewport=container.querySelector('.flows-canvas-scroll')!,canvas=container.querySelector('.flows-canvas') as HTMLElement;
    fireEvent.pointerDown(viewport,{button:0,clientX:100,clientY:100});
    fireEvent.pointerCancel(viewport);const before=canvas.style.transform;
    fireEvent.pointerMove(viewport,{clientX:300,clientY:250});
    expect(canvas.style.transform).toBe(before);
  });
  it('does not treat a node header drag as a background pan',()=>{
    const {container}=render(<FlowCanvas graph={welcomeFlow()} editable onChange={vi.fn()}/>);
    const canvas=container.querySelector('.flows-canvas') as HTMLElement,before=canvas.style.transform;
    const heading=screen.getByRole('button',{name:'Configurar Mensagem recebida'});
    fireEvent.pointerDown(heading,{button:0,clientX:100,clientY:100});
    fireEvent.pointerMove(heading,{clientX:160,clientY:130});
    fireEvent.pointerUp(heading);
    expect(canvas.style.transform).toBe(before);
  });
  it('opens a widely spread import at a usable scale and can focus the selection at 100%',()=>{
    const graph=welcomeFlow();graph.nodes[1]!.position={x:40000,y:20000};
    const {container}=render(<FlowCanvas graph={graph} editable onChange={vi.fn()}/>);
    expect(screen.queryByText('2%')).not.toBeInTheDocument();
    expect(screen.getByText('25%')).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'Centralizar seleção em 100%'}));
    expect((container.querySelector('.flows-canvas') as HTMLElement).style.transform).toContain('scale(1)');
  });
  it('renders negative source coordinates inside the visible canvas without rewriting the graph', () => {
    const graph=welcomeFlow();
    graph.nodes=graph.nodes.map(node=>({...node,position:{x:node.position.x-5000,y:node.position.y-4000}}));
    const change=vi.fn();
    render(<FlowCanvas graph={graph} editable onChange={change}/>);
    const node=screen.getByRole('button',{name:'Configurar Mensagem recebida'}).parentElement!;
    expect(parseFloat(node.style.left)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(node.style.top)).toBeGreaterThanOrEqual(0);
    expect(change).not.toHaveBeenCalled();
  });
  it('fits a distant imported graph and resets scrolling when requesting the overview', () => {
    const graph=welcomeFlow();graph.nodes=graph.nodes.map(node=>({...node,position:{x:node.position.x+12000,y:node.position.y+5000}}));
    const {container}=render(<FlowCanvas graph={graph} editable onChange={vi.fn()}/>);
    const scroll=container.querySelector('.flows-canvas-scroll') as HTMLElement;
    scroll.scrollLeft=500;scroll.scrollTop=500;
    fireEvent.click(screen.getByRole('button',{name:'Visão geral'}));
    expect(scroll.scrollLeft).toBe(0);expect(scroll.scrollTop).toBe(0);
  });
  it('duplicates a selected block with a fresh id and restores graph edits through undo and redo',()=>{
    render(<Editor/>);
    fireEvent.click(screen.getByRole('button',{name:'Configurar Boas-vindas'}));
    fireEvent.click(screen.getByRole('button',{name:'Duplicar bloco selecionado'}));
    expect(screen.getAllByRole('button',{name:/Configurar Boas-vindas/})).toHaveLength(2);
    fireEvent.click(screen.getByRole('button',{name:'Desfazer'}));
    expect(screen.getAllByRole('button',{name:/Configurar Boas-vindas/})).toHaveLength(1);
    fireEvent.click(screen.getByRole('button',{name:'Refazer'}));
    expect(screen.getAllByRole('button',{name:/Configurar Boas-vindas/})).toHaveLength(2);
  });
  it('focuses start and an error block at a readable scale without editing the graph',()=>{
    const graph=welcomeFlow(),change=vi.fn();graph.nodes[1]!.position={x:40000,y:20000};
    const {container}=render(<FlowCanvas graph={graph} editable onChange={change} errorNodeIds={[graph.nodes[1]!.id]}/>);
    fireEvent.click(screen.getByRole('button',{name:'Localizar bloco com erro'}));
    expect(container.querySelector('.flow-node--error')).toContainElement(screen.getByRole('button',{name:'Configurar Boas-vindas'}));
    expect((container.querySelector('.flows-canvas') as HTMLElement).style.transform).toContain('scale(1)');
    fireEvent.click(screen.getByRole('button',{name:'Localizar início'}));
    expect(screen.getByRole('button',{name:'Configurar Mensagem recebida'}).parentElement).toHaveClass('flow-node--selected');
    expect(change).not.toHaveBeenCalled();
  });
  it('moves a node by screen distance divided by zoom and keeps the move as one undo step',()=>{
    const graph=welcomeFlow();graph.nodes[1]!.position={x:40000,y:20000};
    function ZoomEditor(){const [value,setValue]=useState(graph);return <FlowCanvas graph={value} editable onChange={setValue}/>;}
    const {container}=render(<ZoomEditor/>);
    const heading=screen.getByRole('button',{name:'Configurar Boas-vindas'});
    fireEvent.pointerDown(heading,{button:0,clientX:100,clientY:100});
    fireEvent.pointerMove(heading,{clientX:150,clientY:100});
    fireEvent.pointerMove(heading,{clientX:200,clientY:100});
    fireEvent.pointerUp(heading);
    expect(parseFloat(heading.parentElement!.style.left)).toBe(40000+60+400);
    fireEvent.click(screen.getByRole('button',{name:'Desfazer'}));
    expect(parseFloat(heading.parentElement!.style.left)).toBe(40000+60);
  });
});
