# R2 history snapshot core implementation plan

Execução inline já solicitada pelo usuário; sem delegação ou publicação. O corte
consolidado posterior autoriza commits locais após seus gates, sem push/deploy.
Spec: PLANO_FOCAL_R2_HISTORICO_20261017.md. Primeiro incremento é independente
da engine e não habilita importação no servidor.

## Tarefa1 — contrato privado versionado

Arquivos: apps/api/src/modules/history-import/contract.ts e
apps/api/tests/unit/history-import-contract.test.ts.

Interfaces: parseHistorySnapshot(raw,scope,maxRecords,now),
parseHistoryPage(snapshot,expectedOrdinal,raw,now),
historySnapshotFingerprint(snapshot). Snapshot v1 congela org/canal/fingerprint/
revisão, intervalo UTC, expiração, total, pageSize100 e digests SHA256 por página.
Página usa ordinal do snapshot imutável, nunca offset da origem mutável.

- [x] RED de contrato, escopo, budget, expiração, digest, ordem e tipos suportados:16 falhas observadas.
- [x] Implementar validação estrita e fingerprint canônico, sem acesso externo.
- [x] GREEN focal18, typecheck, regressão3169/412 e diff aprovados; core não habilita importação.

## Tarefa2 — ledger durável e checkpoint

Após tarefa1: migration aditiva pelo próximo número disponível, RLS por org,
FK de canal e identidade congelada. Operações start/get/cancel/commitPage sob
locks; requestID idempotente e recibo/digest por página. Persistência histórica e
checkpoint compartilham a mesma transação. RED/GREEN PostgreSQL para replay,
cancelamento concorrente, rollback e isolamento. Não implementar callback externo
dentro da transação nem afirmar atomicidade usando transações separadas.

- [x] Migration0067 com RLS, admissão/purge, guardas de estado e recibo diferido.
- [x] Ledger16/16: replay, rollback, restart, cancelamento nas duas ordens e tenants.
- [x] Upgrade populado0066→0067/readiness/purge: conjunto5files46PASS.
- [x] Revisão independente2P2 reproduzidosRED e fechadosGREEN/re-review.
- [x] Typecheck/diffPASS e regressão412files3169PASS em307,74s.

## Tarefa3 — adaptadores e jornada

Somente após contrato de snapshot real: adaptar engine preservando upstream/
licenças/pin, mapear para ingresso histórico atual, worker e API/UI. Atualizar
inventário de imagens antes de gerar qualquer artefato. Testar restart, limites,
revogação, zero bot/outbox e cobertura do manifesto. Snapshot externo e mídia/
grupos continuam etapas explícitas; não declarar R2 inteiro por concluir o core.

## Fechamento local do adaptador v1 — 19/10/2026

Contrato, ledger, fonte congelada real PostgreSQL, writer compartilhado, API/UI,
worker dedicado e projeção silenciosa JRC implementados e verificados localmente.
Revisão encontrou e corrigiu bootstrap com callbacks; o endpoint dedicado é
idempotente e a corrida com um mapa live usa o vínculo realmente persistido.

Gate após correções:419arquivos/3211testes gerais PASS, TypeScript e build PASS,
scanner11arquivos/sem achados PASS; adaptador9PG e cliente4unit PASS. Fonte/serviço
17PG e UI/Compose23 anteriores são evidência do mesmo recorte de identidade. Testes
populados0065/0066→0067, isolamento, cancelamento e retomada foram verificados.
JRC37Rails + drill real de reversão/reaplicação1PASS; build completo da interface PASS.

O fechamento vale para texto individual disponível no cache a partir da identidade
verificada. Não equivale a histórico integral do telefone, grupos/anexos antigos,
homologação de Chatwoot externo/Meta, dimensionamento ou conclusão do programa.
Nenhuma imagem, push ou operação no servidor foi feita. A migration0067 continua
candidata, deve ser instalada com a imagem futura e a fonte exige papel somente
leitura. Ordem operacional e limites estão no README do módulo.
