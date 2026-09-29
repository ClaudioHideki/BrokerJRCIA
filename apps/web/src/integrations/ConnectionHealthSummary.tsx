import type { ConnectionHealth } from '@jrc/contracts';

const sessions: Record<string, string> = {
  CONNECTED: 'Conectada', CONNECTING: 'Conectando', DISCONNECTED: 'Desconectada', CREATED: 'Criada',
  AWAITING_ACTION: 'Aguardando leitura do QR', PROVISIONING: 'Criando conexão',
  PROVISIONING_FAILED: 'Falha na criação', DEGRADED: 'Com falha', UNKNOWN: 'Não confirmado',
};
function timestamp(value: string | null) {
  return value ? new Date(value).toLocaleString('pt-BR') : 'Ainda não observado';
}

export function ConnectionHealthSummary({ health }: { health: ConnectionHealth }) {
  const verified = health.transportStatus === 'OPERATIONAL' && health.integrationStatus === 'READY'
    && health.instanceStatus === 'CONNECTED' && health.identityApproved && health.identityStatus === 'CONFIRMED'
    && Boolean(health.callbackVerifiedAt && health.lastSuccessfulInboundAt && health.lastSuccessfulOutboundAt);
  return <section className="connection-health" aria-label="Estado verificado da conexão">
    <dl className="connection-health-grid">
      <div><dt>Sessão WhatsApp</dt><dd>{sessions[health.instanceStatus] ?? 'Não confirmado'}</dd></div>
      <div><dt>Caixa de destino</dt><dd>{health.integrationStatus === 'READY' ? 'Vínculo configurado'
        : health.integrationStatus === 'DISABLED' ? 'Integração pausada' : 'Configuração pendente'}</dd></div>
      <div><dt>Identidade do número</dt><dd>{health.identityStatus === 'CONFIRMED' && health.identityApproved
        ? 'Número confirmado' : health.identityStatus === 'CONFIRMATION_REQUIRED'
          ? 'Aguardando confirmação do número' : 'Número ainda não verificado'}</dd>
        {health.observedNumberSuffix && <small>Final observado: {health.observedNumberSuffix}</small>}</div>
      <div><dt>Transporte de mensagens</dt><dd>{verified ? 'Entrega verificada'
        : health.transportStatus === 'DEGRADED' ? 'Entrega com falha' : 'Entrega ainda não comprovada'}</dd></div>
    </dl>
    <dl className="connection-evidence">
      <div><dt>Webhook recebido e validado</dt><dd>{timestamp(health.callbackVerifiedAt)}</dd></div>
      <div><dt>Última mensagem recebida com sucesso</dt><dd>{timestamp(health.lastSuccessfulInboundAt)}</dd></div>
      <div><dt>Última resposta enviada com sucesso</dt><dd>{timestamp(health.lastSuccessfulOutboundAt)}</dd></div>
      <div><dt>Estado consultado em</dt><dd>{timestamp(health.checkedAt)}</dd></div>
    </dl>
    {!verified && <p>Confirme o número, envie uma mensagem de teste ao WhatsApp e responda publicamente pela caixa.
      Use Conferir estado para consultar as evidências. Notas privadas não são enviadas ao WhatsApp.</p>}
  </section>;
}
