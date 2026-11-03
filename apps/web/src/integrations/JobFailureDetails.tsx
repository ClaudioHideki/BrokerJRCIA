import type {IntegrationJob} from '@jrc/contracts';

const phases={TRANSPORT:'Comunicação com a central',HTTP_STATUS:'Resposta HTTP da central',RESPONSE_BODY:'Leitura da resposta',UNKNOWN:'Etapa não identificada'};
const settlements={RETRY_SCHEDULED:'Nova tentativa agendada',FAILED:'Tentativa encerrada com falha',UNKNOWN:'Resultado remoto incerto'};

export function JobFailureDetails({diagnostic}:{diagnostic:IntegrationJob['failureDiagnostic']}){
 if(!diagnostic)return null;
 return <details>
  <summary>Última falha observada</summary>
  <p>{phases[diagnostic.phase]}</p>
  <p>{diagnostic.method?`${diagnostic.method} · `:''}{diagnostic.httpStatus===null?'Sem retorno HTTP observado':`HTTP ${diagnostic.httpStatus}`}</p>
  <p>Tentativa {diagnostic.attempt} · {settlements[diagnostic.settlement]}</p>
  <time dateTime={diagnostic.failedAt}>{new Date(diagnostic.failedAt).toLocaleString('pt-BR')}</time>
  <p>Registro da tentativa indicada; pode anteceder uma recuperação. Não comprova que a mensagem deixou de ser enviada.</p>
 </details>;
}
