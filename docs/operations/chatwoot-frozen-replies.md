# Retenção de respostas antigas por original Rails

O worker consulta o vencimento do job. A ferramenta conserva o job `PENDING`, a chave, evidências, erro, tentativas e intenção. Ela grava `available_at='infinity'`, a origem aprovada e o digest do manifesto. Revisões posteriores do mesmo destino podem criar uma nova chave para o mesmo ID Rails. Com a integração habilitada em GUARD ou REVIEW, o worker consulta também as chaves de revisões anteriores antes de reservar. A busca usa a chave única de organização, integração e deduplicação. Uma mensagem de outra conta/caixa/origem segue o seu próprio vínculo.

## Preparação

1. Manter a integração em `CHATWOOT_DIRECT_TRANSPORT_REVIEW_INTEGRATIONS` em todos os workers e na API. Conferir a versão efetiva e a ausência de canônicos/saídas de transporte já armadas. A operação exige destino e credencial nas revisões aprovadas. Conferir a autoridade das obrigações Rails pré-corte, inclusive as que ainda podem emitir o primeiro callback. O manifesto protege os originais presentes nele. A falta de um job antigo no Broker não ampara liberar seu futuro callback.
2. Em transação de leitura consistente, registrar um corte UTC observado pelo banco. Materializar um arquivo privado em bytes estáveis com `organizationId, integrationId, channelId, origin, accountId, inboxId, destinationRevision, credentialRevision, cutoff, expectedCount, jobs`. Cada entrada de `jobs` contém `id` (UUID do job), `messageId` e `conversationId` (inteiros Rails). Conferir a lista, a contagem e seu digest imediatamente antes de aplicar. O programa exige a totalidade dos PENDING pré-corte e recusa qualquer CHATWOOT_REPLY RUNNING na mesma integração.
3. Utilizar conexão direta existente `jrc_app` via `DATABASE_URL`. O comando compilado usa transação de organização com RLS. A prévia valida o manifesto e simula a gravação, encerrando com rollback. O resultado informa apenas digest e contagens.

```text
node apps/api/dist/commands/freeze-reply-cohort.js --org UUID_ORG --integration UUID_INTEGRACAO --manifest ARQUIVO_PRIVADO
node apps/api/dist/commands/freeze-reply-cohort.js --org UUID_ORG --integration UUID_INTEGRACAO --manifest ARQUIVO_PRIVADO --apply SHA256_REVISADO
```

4. Sob a mesma autorização, a aplicação exige o digest dos bytes exatos. Duas execuções simultâneas serializam a conexão e os jobs. Uma divergência de escopo, data, identificação, observação original, lease ou canônico aborta o lote. Uma repetição idêntica retorna zero alterações e mantém uma única auditoria de aplicação. O recibo direto existente pode concluir um original mediante a prova exigida pela ferramenta própria; a marcação da coorte não declara entrega.
5. Conferir o marcador, a data infinita e o estado de todos os jobs do manifesto. Conferir outbox e tentativas QR por canal. Instalar a revisão que protege as chaves alternativas em todos os consumidores antes de retirar o UUID de REVIEW. Preservar a integração em `CHATWOOT_DIRECT_SOURCE_GUARD_INTEGRATIONS` nos workers e na API. Quando o usuário autorizar a retomada, assegurar que a rota direta concorrente está desativada e a identidade viva da caixa foi comprovada. A partir dessa troca, a retenção por original permanece através de reinícios e as respostas novas podem seguir seu fluxo habitual. Restaurar REVIEW caso se detecte divergência. Para uma reversão de versão, colocar REVIEW antes de voltar ao worker anterior. O comando não tem operação de liberação em massa.

## Conferências agregadas

Para formar a parte privada `jobs`, usar a seguinte leitura parametrizada no mesmo snapshot do corte. O resultado contém identificadores internos e deve ficar com o operador. Validar a identidade da conexão e as revisões contra o manifesto antes de aplicar.

```sql
SELECT jsonb_agg(jsonb_build_object('id',id,'messageId',(payload->>'messageId')::bigint,
       'conversationId',(payload->>'conversationId')::bigint) ORDER BY id) AS jobs
FROM integration_jobs WHERE organization_id=$1 AND integration_id=$2 AND kind='CHATWOOT_REPLY'
 AND status='PENDING' AND created_at<=$3::timestamptz;
```

```sql
-- Broker, $1 org, $2 integração, $3 corte UTC, $4 digest privado revisado.
SELECT count(*) AS pending_before_cut,
       count(*) FILTER (WHERE available_at='infinity' AND payload->'frozenReply'->>'digest'=$4) AS frozen_exact,
       count(*) FILTER (WHERE lease_token IS NOT NULL OR message_id IS NOT NULL) AS leased_or_canonical
FROM integration_jobs WHERE organization_id=$1 AND integration_id=$2
 AND kind='CHATWOOT_REPLY' AND created_at<=$3::timestamptz AND status='PENDING';

-- Rails. $1 conta, $2 caixa, $3 integração, $4 corte UTC, $5 bigint[] IDs Rails do manifesto.
-- Inclui obrigações criadas tarde para mensagens já antigas.
SELECT o.state, o.lease_token IS NOT NULL AS leased,
       o.message_id=ANY($5::bigint[]) AS original_in_manifest, count(*) AS n
FROM jrc_broker_webhook_obligations o JOIN messages m
 ON (m.account_id,m.inbox_id,m.id)=(o.account_id,o.inbox_id,o.message_id)
WHERE o.account_id=$1 AND o.inbox_id=$2 AND o.integration_id=$3
 AND m.created_at<=($4::timestamptz AT TIME ZONE 'UTC')
GROUP BY 1,2,3 ORDER BY 1,2,3;

-- Broker. $1 org, $2 integração, $3 corte, $4 bigint[] IDs Rails do manifesto.
-- Observações aguardando mapa podem gerar seu primeiro job depois da integração voltar.
WITH scope AS (
  SELECT o.*,CASE WHEN o.event->>'remoteMessageId' ~ '^[0-9]{1,18}$'
                  THEN (o.event->>'remoteMessageId')::bigint END AS rails_id
  FROM chatwoot_attendance_observations o WHERE o.organization_id=$1 AND o.integration_id=$2
   AND o.created_at<=$3 AND o.reply_payload IS NOT NULL AND o.event->>'mayForwardReply'='true'
)
SELECT o.disposition,o.rails_id=ANY($4::bigint[]) AS original_in_manifest,
       EXISTS(SELECT 1 FROM integration_jobs j WHERE j.organization_id=o.organization_id AND j.integration_id=o.integration_id
              AND j.kind='CHATWOOT_REPLY' AND j.dedupe_key=concat_ws(':','reply',o.destination_revision,o.account_id,o.inbox_id,o.rails_id)
              AND j.payload->>'attendanceObservationId'=o.id::text) AS job_materialized,
       count(*) AS n
FROM scope o GROUP BY 1,2,3 ORDER BY 1,2,3;
```

Reconciliar privadamente os conjuntos de obrigações, observações e jobs antes de declarar que a coorte cobre tudo que pode chegar. Uma contagem sem IDs e as datas de criação do job e da observação isoladamente não comprovam a idade do original Rails. Também conferir entregas pendentes do executor Rails, observações sem identidade, bindings anteriores e demais emissores previstos na instalação. Sem essa cobertura, manter REVIEW. O ensaio local usa dados sintéticos e não exige um envio físico.
