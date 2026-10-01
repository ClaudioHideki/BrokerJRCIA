// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { executeFlow, type FlowGraph } from '@jrc/contracts';
import { FlowCanvas } from './FlowCanvas.js';

describe('building a question and branch without manual reference syntax', () => {
  it('selects the captured variable and executes the configured branch', () => {
    let latest: FlowGraph = { nodes: [
      { id: 'start', type: 'start', label: 'Início', position: { x: 0, y: 0 }, data: {} },
      { id: 'name', type: 'input', label: 'Nome do cliente', position: { x: 250, y: 0 }, data: { variable: 'nome', text: 'Nome?' } },
      { id: 'condition', type: 'condition', label: 'Verificar nome', position: { x: 500, y: 0 }, data: { field: 'message', operator: 'equals', value: 'Maria' } },
      { id: 'yes', type: 'message', label: 'Confirmar', position: { x: 750, y: 0 }, data: { text: 'Olá, {{nome}}' } },
      { id: 'end', type: 'end', label: 'Fim', position: { x: 1000, y: 0 }, data: {} },
    ], edges: [
      { id: 'a', source: 'start', target: 'name', port: 'next' },
      { id: 'b', source: 'name', target: 'condition', port: 'next' },
      { id: 'c', source: 'condition', target: 'yes', port: 'yes' },
      { id: 'd', source: 'condition', target: 'end', port: 'no' },
      { id: 'e', source: 'yes', target: 'end', port: 'next' },
    ] };
    function Editor() {
      const [graph, setGraph] = useState(latest);
      return <FlowCanvas graph={graph} editable onChange={next => { latest = next; setGraph(next); }} />;
    }
    render(<Editor />);
    fireEvent.click(screen.getByRole('button', { name: 'Configurar Nome do cliente' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Pergunta' }), { target: { value: 'Como você se chama?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Configurar Verificar nome' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Campo' }), { target: { value: 'nome' } });
    const question = executeFlow(latest, { text: 'Olá' });
    expect(question.texts).toEqual(['Como você se chama?']);
    expect(executeFlow(latest, { text: 'Maria', state: question }).texts).toEqual(['Olá, Maria']);
    expect(executeFlow(latest, { text: 'Outro nome', state: question }).texts).toEqual([]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Comparação' }), { target: { value: 'present' } });
    expect(screen.queryByRole('textbox', { name: 'Valor' })).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Comparação' }), { target: { value: 'equals' } });
    expect(screen.getByRole('textbox', { name: 'Valor' })).toHaveValue('Maria');
  });
});
