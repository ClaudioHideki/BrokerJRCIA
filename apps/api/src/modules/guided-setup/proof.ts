import type { SetupCheck, SetupProof } from '@jrc/contracts';

export interface SetupEvidence {
  scopeMatches: boolean; entryReceived: boolean; selectionsReceived: boolean; botDelivered: boolean;
  mirrorConfirmed: boolean; handoffConfirmed: boolean; humanPaused: boolean; unresolvedEffects: boolean;
}
export function evaluateSetupProof(scope: Pick<SetupProof, 'executionId' | 'fingerprint' | 'provider'>, evidence: SetupEvidence): SetupProof {
  const checks: SetupCheck[] = [
    { code: 'TEST_SCOPE', title: 'Execução e revisões correspondem à homologação iniciada.', state: evidence.scopeMatches ? 'PASS' : 'ACTION_REQUIRED' },
    { code: 'REAL_INBOUND', title: 'Mensagem de entrada recebida do WhatsApp de teste.', state: evidence.entryReceived ? 'PASS' : 'UNVERIFIED' },
    { code: 'OPTION_RECEIVED', title: 'Resposta ao menu recebida na mesma conversa.', state: evidence.selectionsReceived ? 'PASS' : 'UNVERIFIED' },
    { code: 'BOT_DELIVERED', title: 'Resposta do robô com confirmação de entrega.', state: evidence.botDelivered ? 'PASS' : 'UNVERIFIED' },
    { code: 'JRC_MIRROR', title: 'Histórico espelhado na caixa selecionada do JRC.', state: evidence.mirrorConfirmed ? 'PASS' : 'UNVERIFIED' },
    { code: 'HANDOFF_CONFIRMED', title: 'Transferência ao atendimento humano confirmada.', state: evidence.handoffConfirmed ? 'PASS' : 'UNVERIFIED' },
    { code: 'HUMAN_PAUSE', title: 'Atendimento assumido pelo agente com robô pausado.', state: evidence.humanPaused ? 'PASS' : 'UNVERIFIED' },
    { code: 'NO_UNCERTAIN_EFFECTS', title: 'Sem envio ou transferência com resultado desconhecido.', state: evidence.unresolvedEffects ? 'ACTION_REQUIRED' : 'PASS' },
  ];
  return { ...scope, source: 'NATIVE_RUNTIME', collectedAt: new Date().toISOString(), passed: checks.every(c => c.state === 'PASS'), checks };
}
