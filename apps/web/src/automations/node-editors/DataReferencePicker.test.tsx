// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FlowNode } from '@jrc/contracts';
import { DataReferencePicker } from './DataReferencePicker.js';

const nodes: FlowNode[] = [
  { id: 'name', type: 'input', label: 'Nome do cliente', position: { x: 0, y: 0 }, data: { variable: 'nome' } },
  { id: 'menu', type: 'menu', label: 'Escolher setor', position: { x: 0, y: 0 }, data: {} },
  { id: 'other', type: 'variable', label: 'Nome repetido', position: { x: 0, y: 0 }, data: { variable: 'nome' } },
  { id: 'unsafe', type: 'input', label: 'Importado', position: { x: 0, y: 0 }, data: { variable: '__proto__.x' } },
];
describe('data reference selection', () => {
  it('offers message and declared captures without duplicate keys or unsafe references', () => {
    const change = vi.fn();
    render(<DataReferencePicker nodes={nodes} value="message" onChange={change} editable />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Campo' }), { target: { value: 'nome' } });
    expect(change).toHaveBeenCalledWith('nome');
    expect(screen.getAllByRole('option').filter(option => (option as HTMLOptionElement).value === 'nome')).toHaveLength(1);
    expect(screen.getByRole('option', { name: /Escolher setor/ })).toHaveValue('menu.choice');
    expect(screen.queryByRole('option', { name: /__proto__/ })).toBeNull();
  });
  it('preserves an imported custom reference and only replaces it on explicit selection', () => {
    const change = vi.fn();
    render(<DataReferencePicker nodes={nodes} value="customer.external" onChange={change} editable />);
    expect(screen.getByRole('textbox', { name: 'Nome do campo personalizado' })).toHaveValue('customer.external');
    expect(change).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Campo' }), { target: { value: 'nome' } });
    expect(change).toHaveBeenCalledWith('nome');
  });
  it('offers the runtime default when the menu variable was cleared', () => {
    render(<DataReferencePicker nodes={[{ ...nodes[1]!, data: { variable: '' } }]} value="message" onChange={vi.fn()} editable />);
    expect(screen.getByRole('option', { name: /Escolher setor/ })).toHaveValue('menu.choice');
  });
  it('does not invent contact variables which the native runtime does not yet populate', () => {
    render(<DataReferencePicker nodes={[]} value="message" onChange={vi.fn()} editable={false} />);
    expect(screen.getByRole('combobox', { name: 'Campo' })).toBeDisabled();
    expect(screen.queryByRole('option', { name: /contact.name|telefone/i })).toBeNull();
  });
});
