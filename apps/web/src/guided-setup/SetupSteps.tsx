export const SETUP_STEPS = ['Empresa e destino', 'WhatsApp', 'Caixa e atendentes', 'Robô e vínculos', 'Conferência e teste'];
export function SetupSteps({ current, onSelect }: { current: number; onSelect(step: number): void }) {
  return <nav aria-label="Etapas da configuração guiada"><ol className="wizard-steps">
    {SETUP_STEPS.map((label, index) => <li key={label} className={current === index ? 'active' : ''}>
      <button type="button" aria-current={current === index ? 'step' : undefined} onClick={() => onSelect(index)}>{label}</button>
    </li>)}
  </ol></nav>;
}
