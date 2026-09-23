// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { welcomeFlow } from '@jrc/contracts';
import { FlowCanvas } from './FlowCanvas.js';

describe('imported graph viewport', () => {
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
});
