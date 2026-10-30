# Incrementos B05, B07 e B13

Base `9e62cea`, branch `codex/broker-audit-fixes-20261029`. Execução local, sem infraestrutura produtiva. Resultados finais de consolidação e revisão serão vinculados no relatório da fase.

## B05 — logs sob controle JRC

**Problema reproduzido:** um envelope estruturado com `data`, `content`, `sender`, JID, mídia em base64 e assinatura era conservado no log; `Error.name/code` aceitavam texto arbitrário; um array circular causava recursão sem limite. Três regressões novas falharam antes da correção.

**Correção:** ampliar a remoção recursiva dos campos de conteúdo/identificação, restringir metadados de erro a tipos conhecidos, código canônico e status HTTP válido; detectar ciclos também em arrays. Campos operacionais como evento/attempts/requestId permanecem.

**Arquivos:** `packages/security/src/redaction/logger.ts` e `packages/security/tests/redaction.test.ts`.

**Teste executado:** redaction + logger Fastify + audit redaction: 3 arquivos, 38 testes, exit 0. Sem rede externa ou banco. A suíte geral será repetida na consolidação.

**Compatibilidade:** não altera payload/resposta HTTP; reduz conteúdo de logs intencionalmente. Logs livres em `msg` continuam exigindo mensagens estáticas; o sanitizer não consegue inferir segredo em qualquer texto arbitrário.

**Infraestrutura e risco residual:** nenhuma migration/ENV. Não sanitiza stdout de processo externo. A fonte Evolution continua com logging sensível condicionado à configuração; B05 integral exige atestar imagem/configuração e alterar a receita da engine em incremento próprio. Nenhuma alegação de vazamento produtivo.

## B07 — watermark de conexão

**Problema reproduzido:** `date_time` era descartado; close atrasado podia alterar estado e invalidar identidade/atendimento após um open mais recente. Duas regressões novas do normalizador falharam na base.

**Correção:** preservar timestamp ISO válido no domínio de relógio da engine autenticada, persistir watermark por instância/binding autenticado e aceitar apenas fatos estritamente mais novos nesse domínio. Empate e ausência de timestamp não sobrescrevem watermark existente. Antes de haver watermark, o comportamento legado é conservado. Filtro ocorre antes de identity scope, grupos e observação da central. A instância é bloqueada antes do canal para não introduzir upgrade concorrente de SHARE após segurar o canal.

**Arquivos:** `qr-events.ts`, `qr-service.ts`, novo `qr-connection-order.ts` em `apps/api/src/modules/messaging/`; `apps/api/src/db/schema.ts`; migration `0076_qr_connection_watermark.sql`; testes `apps/api/tests/unit/qr-events.test.ts`, `qr-connection-order.test.ts` e integração `qr-chatwoot-storage.test.ts`.

**Teste executado:** 2 arquivos unitários, 25 testes, exit 0. Casos PostgreSQL de close antigo/empate/legado, ingresso simultâneo e isolamento foram acrescentados, ainda não executados por falta de cluster local exclusivo disponível. Um módulo ausente gerou a primeira falha do teste de watermark; a reprodução comportamental anterior veio do normalizador, não de uma execução SQL.

**Compatibilidade:** contrato público permanece igual; metadados internos do evento e duas colunas nullable são aditivos. Um evento sem timestamp depois de um watermark é ignorado, não pode fingir ser uma observação mais recente.

**Migration e rollback:** incluir 0076 depois de 0075 no journal. Não foi aplicada aqui. Rollback operacional conservador: retornar o código anterior e manter as colunas adicionais; ele as ignora. Não remover watermarks em uso para esconder regressão. Não há backfill inferido dos timestamps históricos de atualização.

**Risco residual:** a fonte Evolution usa representação local marcada como Z; os fatos são comparados somente no domínio do binding e não contra a hora do Broker. Recuo de clock/fuso no mesmo binding exige reconciliação e relógio operacional estável. Polling/reconciliação da instância mantém suas próprias proteções de snapshot; não se alega ordenação global entre todos os produtores. Troca de engine precisa de binding/credencial vigente; relógio novo não autoriza replay de dono antigo.

## B13 — orçamento sem elevação arbitrária

**Problema reproduzido:** history import tinha configuração própria ausente da união de perfis; o planejador recusava componentes de partner/history e não incluía réplicas transitórias do rollout. Dois testes novos positivos falharam na base.

**Correção:** incluir perfil history import no helper comum, mantendo max 2, teto 8, aquisição 5 s e idle 10 s. O planejador offline aceita os componentes pertinentes e `rolloutReplicas` opcional, somando coexistência antes de avaliar folga SQL. Entradas inválidas são recusadas e não há mutação do inventário fornecido.

**Arquivos:** `apps/api/src/db/pool-budget.ts`, `commands/history-import-worker.ts`, `scripts/operations/capacity-report.mjs`, respectivos testes e `docs/operations/database-pool-budget.md`.

**Teste executado:** 2 arquivos, 80 testes, exit 0, incluindo orçamento negativo após rollout e limites inválidos.

**Compatibilidade:** defaults, quotas comerciais e tamanhos dos pools existentes permanecem iguais. O JSON do planejador é ampliado apenas quando solicitado rollout; `capacityValidated` segue false. Nenhum Compose/ENV ou servidor foi alterado.

**Infraestrutura e risco residual:** inventário deve somar todas as réplicas, fontes históricas, Evolution e reservas de operação. A ferramenta usa dados do operador, não descobre o host. API_APP/API_AUTH preservam aquisição sem timeout por compatibilidade; configurar deadline finito depende do SLO. Quotas por tenant ainda precisam ser definidas para o piloto, sem que aumentar quota prove capacidade.

Revisão B07: schema declarativo inicialmente colocou colunas em provider_accounts; regressão detectou e correção moveu para instances. A validação fleet tomava SHARE antes do lock exclusivo; regressão de ordem no serviço real detectou e correção antecipa FOR UPDATE após autenticação. O teto inicial de futuro foi removido após prova de incompatibilidade com a fonte local-Z. As três regressões passaram; concorrência PostgreSQL real permanece pendente.
