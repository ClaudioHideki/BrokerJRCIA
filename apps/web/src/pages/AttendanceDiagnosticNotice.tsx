import type { AttendanceDiagnostic } from '@jrc/contracts';
export const attendanceReasonText:Record<AttendanceDiagnostic['reason'],string>={
  NONE:'O bot está liberado para esta conversa.',HUMAN_CONTROL:'A central está sob controle humano. Retome o bot pela conversa após concluir o atendimento.',
  LOCAL_HUMAN:'O atendimento humano está ativo. Escolha como retomar o bot.',REMOTE_INITIALIZING:'A central ainda não confirmou o controle desta conversa.',
  REMOTE_RECONCILE:'Há uma confirmação pendente na central. Reconcilie a entrega antes de retomar.',REMOTE_PAUSED:'A central mantém o bot pausado. Revise o atendimento antes de retomar.',
  SCOPE_CHANGED:'A conexão com a central mudou ou está indisponível. Valide a caixa e a credencial.',OWNER_CHANGED:'A caixa não possui uma automação ativa sob controle do Broker. Revise o vínculo da automação.',
  SESSION_PAUSED:'A sessão do bot está pausada. Escolha como retomar pela conversa.',
};
export function AttendanceDiagnosticNotice({diagnostic}:{diagnostic?:AttendanceDiagnostic|undefined}){
  return !diagnostic||diagnostic.allowed?null:<p role="status" className="flows-alert">{attendanceReasonText[diagnostic.reason]}</p>;
}
