// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FlowNode } from '@jrc/contracts';
import { InputEditor } from './InputEditor.js';

const node: FlowNode = { id: 'input', type: 'input', label: 'Perguntar nome', position: { x: 0, y: 0 },
  data: { text: 'Qual seu nome?', variable: 'nome', importedMetadata: { source: 'synthetic' } } };
describe('simple conversational input editor', () => {
  it('edits the capture name without dropping imported metadata or adding unsupported policies', () => {
    const change = vi.fn();
    render(<InputEditor node={node} editable onChange={change} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Variável' }), { target: { value: 'cliente.nome' } });
    expect(change).toHaveBeenCalledWith({ ...node.data, variable: 'cliente.nome' });
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });
  it('validates unsafe names using the node contract and preserves the invalid draft', () => {
    const change = vi.fn();
    render(<InputEditor node={{ ...node, data: { ...node.data, variable: 'constructor' } }} editable onChange={change} />);
    expect(screen.getByRole('textbox', { name: 'Variável' })).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Nome de variável inválido');
    expect(change).not.toHaveBeenCalled();
  });
  it('shows imported unsupported timeout for repair without silently deleting it', () => {
    const change = vi.fn();
    render(<InputEditor node={{ ...node, data: { ...node.data, timeout: 20 } }} editable onChange={change} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Timeout');
    fireEvent.click(screen.getByRole('button', { name: 'Remover timeout importado' }));
    expect(change).toHaveBeenCalledWith(node.data);
  });
  it('keeps question and repair actions read-only without permission', () => {
    render(<InputEditor node={{ ...node, data: { ...node.data, timeout: 20 } }} editable={false} onChange={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: 'Pergunta' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remover timeout importado' })).toBeDisabled();
  });
});
