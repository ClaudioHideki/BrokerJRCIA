import { useId, useState } from 'react';
import { getNodeDefinition, type FlowNode } from '@jrc/contracts';

type Props = { nodes: readonly FlowNode[]; value: string; onChange: (value: string) => void; editable: boolean };
export function DataReferencePicker({ nodes, value, onChange, editable }: Props) {
  const helpId = useId();
  const [custom, setCustom] = useState(false);
  const references = new Map<string, string>([['message', 'Última mensagem recebida']]);
  const capture = getNodeDefinition('input', 1)!;
  for (const node of nodes) {
    if (!['input', 'menu', 'variable'].includes(node.type)) continue;
    const variable = node.type === 'menu' ? (node.data.variable || 'menu.choice') : (node.data.variable ?? '');
    if (typeof variable === 'string' && capture.schema.safeParse({ variable }).success && !references.has(variable)) {
      references.set(variable, node.label + ' — ' + variable);
    }
  }
  const customValue = custom || !references.has(value);
  return <div className="automation-reference-picker">
    <label>Campo<select value={customValue ? ':custom' : value} disabled={!editable} aria-describedby={helpId}
      onChange={event => {
        if (event.target.value === ':custom') setCustom(true);
        else { setCustom(false); onChange(event.target.value); }
      }}>
      {[...references].map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      <option value=":custom">Campo personalizado</option>
    </select></label>
    {customValue && <label>Nome do campo personalizado<input value={value} disabled={!editable} maxLength={100}
      onChange={event => onChange(event.target.value)} /></label>}
    <p id={helpId}>Os dados capturados ficam disponíveis depois que o cliente passa pelo bloco correspondente. Conecte esse bloco antes da condição.</p>
  </div>;
}
