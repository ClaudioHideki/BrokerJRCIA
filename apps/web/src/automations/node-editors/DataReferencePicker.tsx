import { useId, useState } from 'react';
import { getNodeDefinition, type FlowNode } from '@jrc/contracts';
import {DataVariableKeySchema,isDataNodeType} from '@jrc/contracts';

type Props = { nodes: readonly FlowNode[]; value: string; onChange: (value: string) => void; editable: boolean; label?: string; error?: string | undefined };
export function DataReferencePicker({ nodes, value, onChange, editable, label = 'Campo', error }: Props) {
  const helpId = useId();
  const [custom, setCustom] = useState(false);
  const references = new Map<string, string>([['message', 'Última mensagem recebida']]);
  const capture = getNodeDefinition('input', 1)!;
  for (const node of nodes) {
    if(isDataNodeType(node.type)&&node.data.configVersion===2){
      for(const field of ['target','errorVariable']){const output=node.data[field];if(DataVariableKeySchema.safeParse(output).success&&!references.has(String(output)))references.set(String(output),node.label+' — '+String(output));}
    }
    if (!['input', 'menu', 'variable'].includes(node.type)) continue;
    const variable = node.type === 'menu' ? (node.data.variable || 'menu.choice') : (node.data.variable ?? '');
    if (typeof variable === 'string' && capture.schema.safeParse({ variable }).success && !references.has(variable)) {
      references.set(variable, node.label + ' — ' + variable);
    }
  }
  const customValue = custom || !references.has(value);
  return <div className="automation-reference-picker">
    <label>{label}<select value={customValue ? ':custom' : value} disabled={!editable} aria-invalid={Boolean(error)} aria-describedby={helpId}
      onChange={event => {
        if (event.target.value === ':custom') setCustom(true);
        else { setCustom(false); onChange(event.target.value); }
      }}>
      {[...references].map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      <option value=":custom">Campo personalizado</option>
    </select></label>
    {customValue && <label>Nome do campo personalizado<input value={value} disabled={!editable} maxLength={100} aria-invalid={Boolean(error)} aria-describedby={helpId}
      onChange={event => onChange(event.target.value)} /></label>}
    <p id={helpId}>{error??'As sugestões vêm dos blocos do fluxo. Uma variável só existe depois que o caminho correspondente a produz.'}</p>
  </div>;
}
