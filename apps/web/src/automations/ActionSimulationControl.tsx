import { useState } from 'react';
import type { ActionSimulationResponse, ConversationEffectWait } from '@jrc/contracts';

export function ActionSimulationControl({ wait, disabled, onResponse }: {
  wait: ConversationEffectWait; disabled: boolean; onResponse(event: ActionSimulationResponse): void;
}) {
  const [selection, setSelection] = useState<{ waitId: string; outcome: ActionSimulationResponse['outcome'] }>({ waitId: wait.waitId, outcome: 'success' });
  const outcome = selection.waitId === wait.waitId ? selection.outcome : 'success';
  return <fieldset disabled={disabled}>
    <p>Resultado fictício: nenhum atendimento, mensagem ou arquivo real será alterado.</p>
    {wait.operation === 'resolve' && <p>Uma confirmação encerra o ciclo do bot, sem próxima mensagem.</p>}
    <label>Resultado fictício da ação<select value={outcome} onChange={event => setSelection({
      waitId: wait.waitId, outcome: event.target.value as ActionSimulationResponse['outcome'],
    })}>
      <option value="success">Confirmada</option><option value="error">Falha antes do despacho</option>
      <option value="timeout">Prazo encerrado antes do despacho</option><option value="unknown">Ainda sem confirmação</option>
    </select></label>
    {outcome === 'unknown' && <p>A ação permanece aguardando confirmação e não avança para outro bloco.</p>}
    <button type="button" onClick={() => {
      if (!disabled) onResponse({ type: 'ACTION_RESPONSE', nodeId: wait.nodeId, waitId: wait.waitId, outcome });
    }}>Aplicar resultado fictício</button>
  </fieldset>;
}
