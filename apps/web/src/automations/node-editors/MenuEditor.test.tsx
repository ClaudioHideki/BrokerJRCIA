// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { FlowGraph, FlowNode } from '@jrc/contracts';
import { MenuEditor } from './MenuEditor.js';

const options = [
  { value: '1', label: 'Comercial', custom: 'preserve' },
  { value: '2', label: 'Suporte' },
  { value: '3', label: 'Financeiro' },
];
const node: FlowNode = {
  id: 'menu', type: 'menu', label: 'Atendimento', position: { x: 0, y: 0 },
  data: { text: 'Escolha', variable: 'setor', preserved: 'unchanged', options },
};
const edges: FlowGraph['edges'] = [
  { id: 'e1', source: 'menu', port: 'option-1', target: 'sales' },
  { id: 'e2', source: 'menu', port: 'option-2', target: 'support' },
  { id: 'e3', source: 'menu', port: 'option-3', target: 'finance' },
  { id: 'other', source: 'other-menu', port: 'option-2', target: 'support' },
];
function setup(initial = node, editable = true) {
  const changed = vi.fn();
  function Editor() {
    const [current, setCurrent] = useState(initial);
    const [connections, setConnections] = useState(edges);
    return <MenuEditor node={current} edges={connections} editable={editable} onChange={(data, nextEdges) => {
      changed(data, nextEdges);
      setCurrent({ ...current, data }); setConnections(nextEdges);
    }} />;
  }
  render(<Editor />);
  return changed;
}
describe('visual menu configuration', () => {
  it('reorders display without renumbering choices or changing branch identities', () => {
    const changed = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Mover opção 2 para cima' }));
    const [data, nextEdges] = changed.mock.lastCall!;
    expect(data.options).toEqual([options[1], options[0], options[2]]);
    expect(nextEdges).toEqual(edges);
    expect(data.preserved).toBe('unchanged');
    expect(screen.getAllByRole('group', { name: /^Opção / }).map(group => within(group).getByRole('textbox').getAttribute('value')))
      .toEqual(['Suporte', 'Comercial', 'Financeiro']);
  });
  it('removes only the branch belonging to the removed option and keeps at least two options', () => {
    const changed = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Remover opção 2' }));
    expect(changed.mock.lastCall![1]).toEqual([edges[0], edges[2], edges[3]]);
    expect(changed.mock.lastCall![0].options).toEqual([options[0], options[2]]);
    expect(screen.getByRole('button', { name: 'Remover opção 1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remover opção 3' })).toBeDisabled();
  });
  it('changes a choice number atomically with its connection and disallows duplicate numbers', () => {
    const changed = setup();
    const number = screen.getByRole('combobox', { name: 'Número da opção 2' });
    expect(within(number).getByRole('option', { name: '1' })).toBeDisabled();
    fireEvent.change(number, { target: { value: '8' } });
    const [data, nextEdges] = changed.mock.lastCall!;
    expect(data.options[1]).toEqual({ value: '8', label: 'Suporte' });
    expect(nextEdges).toEqual([edges[0], { ...edges[1], port: 'option-8' }, edges[2], edges[3]]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Texto da opção 1' }), { target: { value: 'Vendas' } });
    expect(changed.mock.lastCall![0].options[0]).toEqual({ value: '1', label: 'Vendas', custom: 'preserve' });
  });
  it('adds an unused number and stops at the supported ten choices', () => {
    const initial = { ...node, data: { ...node.data, options: [
      { value: '9', label: 'Especial' }, { value: '1', label: 'Comercial' },
    ] } };
    const changed = setup(initial);
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar opção' }));
    expect(changed.mock.lastCall![0].options[2]).toEqual({ value: '2', label: 'Nova opção' });
    for (let i = 3; i < 10; i++) fireEvent.click(screen.getByRole('button', { name: 'Adicionar opção' }));
    expect(screen.getAllByRole('group', { name: /^Opção / })).toHaveLength(10);
    expect(screen.getByRole('button', { name: 'Adicionar opção' })).toBeDisabled();
  });
  it('keeps keyboard focus on the renamed choice number', () => {
    setup();
    const number = screen.getByRole('combobox', { name: 'Número da opção 2' });
    number.focus();
    fireEvent.change(number, { target: { value: '8' } });
    expect(screen.getByRole('combobox', { name: 'Número da opção 8' })).toHaveFocus();
  });
  it('preserves invalid imported entries until explicitly repaired and identifies a missing label', () => {
    const initial = { ...node, data: { ...node.data, options: [null, { value: '2', label: '' }, { value: '3', label: 'Suporte' }] } };
    const changed = setup(initial);
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByText(/Há opções importadas que precisam de correção/)).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Texto da opção 2' })).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(screen.getByRole('textbox', { name: 'Texto da opção 2' }), { target: { value: 'Financeiro' } });
    expect(changed.mock.lastCall![0].options[0]).toBeNull();
  });
  it('disables configuration and mutations for a reader', () => {
    const changed = setup(node, false);
    expect(screen.getByRole('button', { name: 'Adicionar opção' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Número da opção 2' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Texto da opção 1' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remover opção 2' }));
    expect(changed).not.toHaveBeenCalled();
  });
});
