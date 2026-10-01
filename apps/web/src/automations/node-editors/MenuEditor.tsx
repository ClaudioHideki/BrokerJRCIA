import { useId, useLayoutEffect, useRef } from 'react';
import type { FlowGraph, FlowNode } from '@jrc/contracts';

type Props = {
  node: FlowNode;
  edges: FlowGraph['edges'];
  editable: boolean;
  onChange: (data: FlowNode['data'], edges: FlowGraph['edges']) => void;
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
const validNumber = (value: string) => /^[1-9][0-9]?$/.test(value);

/** Choice values are port identities. Moving a row must not renumber its branch. */
export function MenuEditor({ node, edges, editable, onChange }: Props) {
  const helpId = useId();
  const container = useRef<HTMLFieldSetElement>(null);
  const restoreNumberFocus = useRef<{ nodeId: string; value: string } | null>(null);
  useLayoutEffect(() => {
    const target = restoreNumberFocus.current;
    restoreNumberFocus.current = null;
    if (editable && target?.nodeId === node.id) {
      container.current?.querySelector<HTMLSelectElement>(`select[data-option-number="${target.value}"]`)?.focus();
    }
  }, [node.id, node.data.options, editable]);
  const options: unknown[] = Array.isArray(node.data.options) ? node.data.options : [];
  const values = options.map(option => text(record(option).value).trim());
  const invalid = options.some((raw, index) => !validNumber(values[index]!) ||
    values.filter(value => value === values[index]).length > 1 ||
    !text(record(raw).label).trim() || text(record(raw).label).trim().length > 120);
  function save(next: unknown[], nextEdges = edges) {
    if (editable) onChange({ ...node.data, options: next }, nextEdges);
  }
  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= options.length) return;
    const next = [...options];
    [next[index], next[target]] = [next[target], next[index]];
    save(next);
  }
  function renumber(index: number, value: string, retainFocus: boolean) {
    if (!editable || !validNumber(value) || values.some((used, at) => at !== index && used === value)) return;
    if (retainFocus) restoreNumberFocus.current = { nodeId: node.id, value };
    const oldValue = values[index]!;
    const uniqueOldValue = values.filter(used => used === oldValue).length === 1;
    const nextEdges = uniqueOldValue
      ? edges.map(edge => edge.source === node.id && edge.port === 'option-' + oldValue ? { ...edge, port: 'option-' + value } : edge)
      : edges;
    save(options.map((option, at) => at === index ? { ...record(option), value } : option), nextEdges);
  }
  function remove(index: number) {
    if (options.length <= 2) return;
    const value = values[index]!;
    const stillUsed = values.some((other, at) => at !== index && other === value);
    save(options.filter((_, at) => at !== index),
      stillUsed ? edges : edges.filter(edge => edge.source !== node.id || edge.port !== 'option-' + value));
  }
  function add() {
    if (options.length >= 10) return;
    const unused = Array.from({ length: 99 }, (_, index) => String(index + 1)).find(value => !values.includes(value));
    if (unused) save([...options, { value: unused, label: 'Nova opção' }]);
  }
  return <fieldset ref={container} className="automation-menu-editor" disabled={!editable} aria-describedby={helpId}>
    <legend>Opções do menu</legend>
    <p id={helpId}>Adicione de 2 a 10 opções. Ao mover uma opção, seu número e destino são mantidos. Remover uma opção também remove sua conexão, preservando o bloco de destino.</p>
    {invalid && <p role="alert">Há opções importadas que precisam de correção. Use números únicos de 1 a 99 e preencha os textos.</p>}
    {options.map((raw, index) => {
      const option = record(raw), value = values[index]!, label = text(option.label);
      const identity = validNumber(value) ? value : 'importada ' + (index + 1);
      const numberInvalid = !validNumber(value) || values.filter(used => used === value).length > 1;
      const labelInvalid = !label.trim() || label.trim().length > 120;
      const errorId = helpId + '-label-' + index;
      const stableKey = values.filter(used => used === value).length === 1 ? value : 'imported-' + index;
      return <fieldset className="automation-menu-option" key={stableKey} aria-label={'Opção ' + identity}>
        <legend>Opção {identity}</legend>
        <label>Número<select data-option-number={value} aria-label={'Número da opção ' + identity} value={validNumber(value) ? value : ''} aria-invalid={numberInvalid}
          onChange={event => renumber(index, event.target.value, event.currentTarget === event.currentTarget.ownerDocument.activeElement)}>
          {!validNumber(value) && <option value="">Escolha um número</option>}
          {Array.from({ length: 99 }, (_, at) => String(at + 1)).map(number =>
            <option key={number} value={number} disabled={values.some((used, at) => at !== index && used === number)}>{number}</option>)}
        </select></label>
        <label>Texto da opção<input aria-label={'Texto da opção ' + identity} value={label} maxLength={120} required
          aria-invalid={labelInvalid} aria-describedby={labelInvalid ? errorId : undefined}
          onChange={event => save(options.map((current, at) => at === index ? { ...record(current), label: event.target.value } : current))}/></label>
        {labelInvalid && <p id={errorId}>Informe um texto de até 120 caracteres.</p>}
        <div className="automation-menu-actions">
          <button type="button" disabled={!editable || index === 0} aria-label={'Mover opção ' + identity + ' para cima'} onClick={() => move(index, -1)}>Subir</button>
          <button type="button" disabled={!editable || index === options.length - 1} aria-label={'Mover opção ' + identity + ' para baixo'} onClick={() => move(index, 1)}>Descer</button>
          <button type="button" disabled={!editable || options.length <= 2} aria-label={'Remover opção ' + identity} onClick={() => remove(index)}>Remover</button>
        </div>
      </fieldset>;
    })}
    <button type="button" disabled={!editable || options.length >= 10} onClick={add}>Adicionar opção</button>
  </fieldset>;
}
