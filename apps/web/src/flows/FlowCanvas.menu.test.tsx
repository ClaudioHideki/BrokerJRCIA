// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { executeFlow, type FlowGraph } from '@jrc/contracts';
import { FlowCanvas } from './FlowCanvas.js';

const makeGraph = (): FlowGraph => ({
  nodes: [
    { id: 'start', type: 'start', label: 'Início', position: { x: 0, y: 0 }, data: {} },
    { id: 'menu', type: 'menu', label: 'Menu principal', position: { x: 250, y: 0 }, data: {
      text: 'Escolha', variable: 'setor',
      options: [{ value: '1', label: 'Comercial' }, { value: '2', label: 'Suporte' }, { value: '3', label: 'Financeiro' }],
    } },
    ...['sales', 'support', 'finance'].map((id, index) => ({ id, type: 'message', label: id, position: { x: 500, y: index * 180 }, data: { text: id } })),
    { id: 'end', type: 'end', label: 'Fim', position: { x: 750, y: 0 }, data: {} },
  ],
  edges: [
    { id: 'start-menu', source: 'start', target: 'menu', port: 'next' },
    ...['sales', 'support', 'finance'].flatMap((target, index) => [
      { id: 'menu-' + target, source: 'menu', target, port: 'option-' + (index + 1) },
      { id: target + '-end', source: target, target: 'end', port: 'next' },
    ]),
  ],
});
describe('menu editing in the canvas', () => {
  function setup() {
    let latest = makeGraph();
    function Editor() {
      const [graph, setGraph] = useState(latest);
      return <FlowCanvas graph={graph} editable onChange={next => { latest = next; setGraph(next); }} />;
    }
    render(<Editor />);
    fireEvent.click(screen.getByRole('button', { name: 'Configurar Menu principal' }));
    return () => latest;
  }
  it('keeps the chosen branch executable after reorder and number change', () => {
    const latest = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Mover opção 2 para cima' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Número da opção 2' }), { target: { value: '8' } });
    expect(latest().edges.find(edge => edge.id === 'menu-support')).toEqual({
      id: 'menu-support', source: 'menu', target: 'support', port: 'option-8',
    });
    expect(screen.getByRole('combobox', { name: 'Destino Opção 8' })).toHaveValue('support');
    const prompt = executeFlow(latest(), { text: 'Olá' });
    const answer = executeFlow(latest(), { text: '8', state: prompt });
    expect(answer.texts).toEqual(['support']);
    expect(answer.variables.setor).toBe('8');
  });
  it('undoes a removal together with the connection and keeps destination nodes', () => {
    const latest = setup();
    const original = structuredClone(latest());
    fireEvent.click(screen.getByRole('button', { name: 'Remover opção 2' }));
    expect(latest().edges.some(edge => edge.id === 'menu-support')).toBe(false);
    expect(latest().nodes.some(node => node.id === 'support')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer' }));
    expect(latest()).toEqual(original);
    fireEvent.click(screen.getByRole('button', { name: 'Refazer' }));
    expect(latest().edges.some(edge => edge.id === 'menu-support')).toBe(false);
  });
});
