# B12 — replay explícito e estatísticas de delivery

Estado: implementação local para revisão, com unitários/HTTP GREEN; PostgreSQL real NÃO EXECUTADO. Nenhuma migration aplicada, serviço externo acessado, mensagem enviada, dependência instalada, commit, push ou deploy.

## Causa e correção

A base encerrava deliveries após falha permanente ou dez tentativas e oferecia apenas inspeção/pull do feed. Não havia intenção durável de replay nem agregação de fila. O novo POST `/v1/partner-webhook-deliveries/:id/replay` aceita somente `{}`, exige `Idempotency-Key` UUID e retorna `schemaVersion: 1` com identidade de replay, eventId/deliveryId/endpointId preservados, número do ciclo e tentativas anteriores. Retorna HTTP 200 tanto na primeira aceitação quanto na repetição idempotente, com `replayed` distinto.

A autorização dos dois contratos novos exige API_KEY e scope explícito atual `webhooks:manage`; JWT ADMIN não basta. A função SQL obtém o tenant da transação, bloqueia organização/chave e rejeita chave expirada, revogada, sem scope ou com qualquer binding de controle Chatwoot. O lock FOR UPDATE da chave também ordena inserções concorrentes de bindings pela FK. A validade temporal é verificada com `clock_timestamp()` após locks e antes de retornar. Endpoint ACTIVE é bloqueado, assim como evento e delivery. Replay exige FAILED sem lease e evento dentro dos 30 dias. Nunca escreve mensagem/outbox WhatsApp.

O ledger `partner_delivery_replays` é imutável para runtime, tem RLS FORCE, política lifecycle, FKs compostas, hash canônico da operação/versão/delivery/corpo vazio e unicidade `(organization_id,authorizing_api_key_id,idempotency_key)`. Intento repetido devolve a identidade anterior mesmo se um worker já iniciou ou concluiu o ciclo; não há novo reset. Mesma chave UUID para outro delivery retorna 409. UUIDs iguais usados por chaves distintas têm namespaces separados; rotação de credencial não transfere a intenção anterior.

Cada ciclo conserva `prior_attempts`, `prior_error_code`, `replay_number` e timestamp no ledger. `attempts` continua 0..10 por ciclo; `lifetime_attempts` acumula claims e é inicializado com as tentativas existentes. O trigger proíbe redução arbitrária de attempts ou reabertura de terminal pelo runtime; apenas a função com ledger coerente pode resetar para PENDING e incrementar replay_count. O lease novo continua usando UUID do worker existente; conclusão com lease de ciclo anterior não encontra a nova execução.

O GET `/v1/partner-webhook-delivery-stats` aceita apenas filtro opcional `endpointId`. Retorna counts por estado, oldestPendingAt, expiredLeases, replays e lifetimeAttempts, com schemaVersion 1 e retentionDays 30; não seleciona payload, URL, segredo ou chave. oldestPendingAt é a menor `available_at` das deliveries PENDING, não a criação original do evento. As métricas contam somente eventos logicamente retidos; lifetimeAttempts é cumulativo entre ciclos das deliveries ainda retidas, não um contador histórico eterno da organização.

## Arquivos

- `apps/api/src/modules/partner-events/service.ts`: contratos de retorno, validação do UUID, chamadas de funções SQL e problemas públicos sanitizados.
- `apps/api/src/http/routes/partner-webhooks.ts`: duas rotas aditivas, schemas estritos e autorização API_KEY.
- `apps/api/drizzle/migrations/0077_partner_delivery_replay.sql`: ledger/colunas, RLS/FKs/catalogue, funções e fences SQL.
- `apps/api/src/modules/partner-events/replay.test.ts`: validação antecipada, identidade, erros e consulta de agregados no limite de serviço.
- `apps/api/tests/http/partner-delivery-replay.test.ts`: contrato público com serviço real e fronteira SQL substituída, scoping, validação, JWT/scope e sanitização.
- `apps/api/tests/integration/partner-delivery-replay.test.ts`: oito cenários reais preparados e protegidos por guard dedicado.

## Evidência

RED observado antes da implementação: 9 testes de serviço falharam pela ausência de replay/deliveryStats; 5 HTTP falharam com 404 das rotas inexistentes. Após a implementação, um erro do harness HTTP por requestId não UUID foi corrigido no próprio fixture para acompanhar a convenção já usada pelos testes legados.

GREEN: `npx vitest run apps/api/src/modules/partner-events apps/api/tests/http/partner-webhooks.test.ts apps/api/tests/http/partner-delivery-replay.test.ts --maxWorkers=1` — 5 arquivos, 31 testes passaram. Inclui comportamento existente de assinatura, retry, lease e endpoints/feed. `git diff --check` passou para o recorte B12.

Coleta sem execução: `npx vitest list apps/api/tests/integration/partner-delivery-replay.test.ts --config vitest.integration.config.ts --maxWorkers=1` — oito testes coletados, sem hooks/migrations/conexão. Cobrem replay concorrente/ACK perdido, ciclos cumulativos, conflito/cross-tenant, estados ativos, endpoint revogado, expiração, lease antigo, fences SQL, agregados, control-binding, expiry pós-lock, revogação concorrente e prune30dias preservando outro tenant.

Os testes PostgreSQL só podem executar com `TEST_PARTNER_REPLAY_EXCLUSIVE_CLUSTER=1` e `TEST_DATABASE_ADMIN_URL` explícita em loopback literal 127.0.0.1/[::1], usuário `lab_` e database administrativo `/lab_`. Não há fallback de DATABASE_URL/ambiente produtivo. O helper cria DB descartável, mas migrations gerenciam papéis globais: exige cluster exclusivo, não apenas DB separado. Nenhum desses testes foi executado nesta tarefa. A prova RED→GREEN cobre serviço/HTTP; o SQL ainda exige RED→GREEN real no laboratório.

## Compatibilidade, integração e risco

Os contratos anteriores e a response Delivery (attempts por ciclo) foram preservados. Não houve alteração em worker, scope de chaves antigas, contratos compartilhados, app.ts, runtime-schema, journal, OpenAPI ou inventário de segurança nesta delegação. O executor principal integra essas áreas e executa typecheck/build/suíte geral coordenada. Novas colunas são mantidas pelo trigger/função; as permissões UPDATE antigas do runtime não devem ser ampliadas.

O ledger acompanha as FKs CASCADE de evento/delivery/endpoint e o catalogue lifecycle. A retenção física já existente de 30 dias elimina ledger e delivery com o evento; não adiciona coletor nem muda retenção das mensagens. Expiração lógica bloqueia replay mesmo antes da limpeza física. Não há rollback destrutivo automático: para rollback operacional, retirar exposição dos dois contratos e interromper novos replays, preservando colunas/ledger; retirar a migration requer tarefa separada após tratar a evidência.

Riscos remanescentes: SQL, locks, grants, RLS, cascatas/lifecycle e concorrência estão inspecionados e cobertos por testes preparados, ainda sem execução PostgreSQL real. Estatísticas são agregadas sobre a janela retida e seu custo depende do volume real; não houve prova de capacidade 900 ou disponibilidade do receptor CCLX. Qualquer nova entrega HTTP pode repetir um evento já persistido no receptor antes de um ACK perdido; o cliente continua responsável por inbox idempotente por organizationId/eventId. Replay não atesta custódia de mídia e não autoriza exclusão de bytes.
