// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ScheduleEditor } from './ScheduleEditor.js';

const original: Record<string, unknown> = { timezone: 'America/Sao_Paulo',
  weekly: [{ day: 1, start: '08:00', end: '18:00', imported: 'retain' }], preserved: { source: 'synthetic' } };
function setup(data = original, editable = true) {
  const change = vi.fn();
  function Editor() {
    const [current, setCurrent] = useState(data);
    return <ScheduleEditor data={current} editable={editable} onChange={next => { change(next); setCurrent(next); }} />;
  }
  render(<Editor />);
  return change;
}

describe('schedule visual editor', () => {
  it('edits timezone and weekly fields without dropping imported metadata', () => {
    const change = setup();
    fireEvent.change(screen.getByRole('textbox', { name: 'Fuso horário' }), { target: { value: 'UTC' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Dia do intervalo 1' }), { target: { value: '0' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Início do intervalo 1' }), { target: { value: '09:00' } });
    expect(change.mock.lastCall![0]).toEqual({ ...original, timezone: 'UTC',
      weekly: [{ day: 0, start: '09:00', end: '18:00', imported: 'retain' }] });
    expect(screen.getByRole('option', { name: 'Domingo' })).toBeInTheDocument();
  });

  it('adds and removes weekly intervals while retaining at least one', () => {
    const change = setup();
    expect(screen.getByRole('button', { name: 'Remover intervalo 1' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar intervalo semanal' }));
    expect(screen.getByRole('textbox', { name: 'Início do intervalo 2' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remover intervalo 1' }));
    expect(change.mock.lastCall![0].weekly).toHaveLength(1);
    expect(change.mock.lastCall![0].preserved).toEqual(original.preserved);
  });

  it('creates a closed holiday and allows explicit exception intervals', () => {
    const change = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar exceção' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Data da exceção 1' }), { target: { value: '2026-12-25' } });
    expect(change.mock.lastCall![0].exceptions).toEqual([{ date: '2026-12-25', intervals: [] }]);
    expect(screen.getByText('Fechado nesta data.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar horário da exceção 1' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Início da exceção 1, intervalo 1' }), { target: { value: '10:00' } });
    expect(change.mock.lastCall![0].exceptions).toEqual([{ date: '2026-12-25', intervals: [{ start: '10:00', end: '18:00' }] }]);
    fireEvent.click(screen.getByRole('button', { name: 'Remover horário da exceção 1, intervalo 1' }));
    expect(change.mock.lastCall![0].exceptions).toEqual([{ date: '2026-12-25', intervals: [] }]);
    fireEvent.click(screen.getByRole('button', { name: 'Remover exceção 1' }));
    expect(change.mock.lastCall![0].exceptions).toEqual([]);
  });

  it('marks exact invalid fields and preserves a malformed draft until repaired', () => {
    const data = { ...original, timezone: 'Mars/Olympus', weekly: [{ day: 1, start: '18:00', end: '08:00' }],
      exceptions: [{ date: '2026-02-29', intervals: [] }] };
    const change = setup(data);
    expect(screen.getByRole('textbox', { name: 'Fuso horário' })).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('textbox', { name: 'Fim do intervalo 1' })).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('textbox', { name: 'Data da exceção 1' })).toHaveAttribute('aria-invalid', 'true');
    expect(change).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Fuso horário' }), { target: { value: 'UTC' } });
    expect(change.mock.lastCall![0].weekly).toEqual(data.weekly);
    expect(change.mock.lastCall![0].exceptions).toEqual(data.exceptions);
  });

  it('preserves extra fields on exception and interval edits', () => {
    const change = setup({ ...original, exceptions: [{ date: '2026-12-25', imported: true,
      intervals: [{ start: '10:00', end: '18:00', legacy: 'retain' }] }] });
    fireEvent.change(screen.getByRole('textbox', { name: 'Fim da exceção 1, intervalo 1' }), { target: { value: '24:00' } });
    expect(change.mock.lastCall![0].exceptions).toEqual([{ date: '2026-12-25', imported: true,
      intervals: [{ start: '10:00', end: '24:00', legacy: 'retain' }] }]);
  });

  it('limits interval creation and keeps controls read-only without edit permission', () => {
    setup({ ...original, weekly: Array.from({ length: 28 }, () => ({ day: 1, start: '08:00', end: '18:00' })),
      exceptions: [{ date: '2026-12-25', intervals: Array.from({ length: 4 }, () => ({ start: '10:00', end: '11:00' })) }] });
    expect(screen.getByRole('button', { name: 'Adicionar intervalo semanal' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Adicionar horário da exceção 1' })).toBeDisabled();
  });

  it('disables every editable field and action without permission', () => {
    const change = setup({ ...original, exceptions: [{ date: '2026-12-25', intervals: [] }] }, false);
    for (const field of screen.getAllByRole('textbox')) expect(field).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Dia do intervalo 1' })).toBeDisabled();
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
    expect(change).not.toHaveBeenCalled();
  });
});
