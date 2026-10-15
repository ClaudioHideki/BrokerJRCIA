import { useId } from 'react';
import { getNodeDefinition, type FlowNode } from '@jrc/contracts';

type Props = { node: FlowNode; editable: boolean; onChange: (data: FlowNode['data']) => void };
const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
export function InputEditor({ node, editable, onChange }: Props) {
  const helpId = useId();
  const parsed = getNodeDefinition('input', 1)!.schema.safeParse(node.data);
  const issues = parsed.success ? [] : parsed.error.issues;
  const variableInvalid = issues.some(issue => issue.path[0] === 'variable');
  const invalidTimeout = issues.some(issue => issue.path[0] === 'timeout');
  const modern=node.data.inputConfigVersion===1;
  const invalidDeadline=issues.some(issue=>issue.path[0]==='timeoutSeconds');
  const save = (key: string, value: unknown) => { if (editable) onChange({ ...node.data, [key]: value }); };
  return <fieldset disabled={!editable} className="automation-input-editor">
    <label>Pergunta<textarea rows={5} maxLength={4096} value={text(node.data.text)} onChange={event => save('text', event.target.value)} /></label>
    <label>Variável<input value={text(node.data.variable)} maxLength={100} aria-invalid={variableInvalid}
      aria-describedby={helpId} onChange={event => save('variable', event.target.value)} /></label>
    <p id={helpId}>A próxima mensagem do cliente será salva como texto nesta variável. Use um nome como nome ou cliente.nome, sem espaços.</p>
    {modern?<><label><input type="checkbox" checked={node.data.timeoutSeconds!==undefined} onChange={event=>{if(!editable)return;const next={...node.data};if(event.target.checked)next.timeoutSeconds=60;else delete next.timeoutSeconds;onChange(next);}}/>Limitar tempo de resposta</label>
      {node.data.timeoutSeconds!==undefined&&<label>Tempo para responder (segundos)<input type="number" min={1} max={604800} step={1} value={text(node.data.timeoutSeconds)} aria-invalid={invalidDeadline} onChange={event=>save('timeoutSeconds',Number(event.target.value))}/></label>}
    </>:<button type="button" disabled={invalidTimeout} onClick={()=>{if(editable)onChange({...node.data,inputConfigVersion:1});}}>Configurar tempo de resposta</button>}
    {issues.length > 0 && <div role="alert">{issues.map((issue, index) => <p key={index}>{issue.path[0]==='timeoutSeconds'?'Informe um número inteiro de 1 a 604800 segundos.':issue.message}</p>)}</div>}
    {invalidTimeout && <button type="button" onClick={() => {
      if (!editable) return;
      const next = { ...node.data }; delete next.timeout; onChange(next);
    }}>Remover timeout importado</button>}
  </fieldset>;
}
