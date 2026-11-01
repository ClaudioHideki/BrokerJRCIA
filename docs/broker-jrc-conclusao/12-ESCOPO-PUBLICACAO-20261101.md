# Escopo vigente — implementação e publicação de 01/11/2026

Base local: `2f1effdfc365592ac9e0f5bbb5bd19b8668ce259`, continuação da PR #6 na branch `codex/broker-jrc-2-redesign-homologacao-20261030`.

## Decisão expressa do usuário

Backup, dump, restore e configuração de políticas de backup estão fora deste incremento. O código existente de recuperação permanece preservado. A dispensa não comprova recuperação de dados, RPO, RTO nem perda zero. As referências a essas tarefas nos checkpoints anteriores são históricas e não são gates a executar nesta rodada.

O usuário autorizou desenvolver, corrigir, gerar a imagem completa e atualizar a aplicação Broker no servidor. Isso não autoriza merge na main, apagar dados, substituir credenciais, alterar configurações produtivas alheias à versão, conectar números reais, disparar mensagens ou reenviar UNKNOWN indiscriminadamente. Antes da atualização, conferir a imagem atualmente efetiva e executar os gates aplicáveis ao novo commit.

## Incrementos em execução

1. Origem Evolution: proveniência notify/append, composição do bootstrap, ownership único e crash/restart isolado. Não ativar uma engine com ownership UNPROVEN.
2. Mídia: worker parceiro real, PostgreSQL, MinIO, autenticação, persistência antes de ACK e recibo de custódia; manter KEEP sem expurgo prematuro.
3. UX: recuperação de falhas de leitura, estado pendente/incerto, reconexão e diagnóstico, usando contratos existentes e RBAC.
4. Consolidação: regressão, typecheck/build, contratos, CI, imagens imutáveis, conferência do servidor e atualização restrita à versão aprovada.

Prioridades preservadas: persistência, retry/idempotência/reconciliação, reconexão/fila offline, mídias, LAB2, painéis administrativo/empresa, integração/falhas/concorrência e capacidade. Eventos sintéticos não homologam sessões reais nem o piloto de 30 dias.

## Exclusão explícita de execução no CI

Somente nesta branch candidata (e PRs cuja origem seja ela), o CI não executa `test:restore-drill`, `tests/backup.test.mjs` ou `tests/recovery.test.mjs`. O workflow de imagens usa as mesmas exclusões unitárias. O resumo de cada run registra que recuperação NÃO foi validada. Outras branches preservam os gates anteriores; nenhum mecanismo produtivo de recuperação foi removido. O comando agregado `ci:verify` permanece intacto e não deve ser usado nesta rodada porque inclui restore.

Continuam obrigatórios os testes de persistência de eventos, reinício de processos, recuperação de fila, idempotência, mídias, isolamento e APIs. Esses testes não são rotinas de backup/restore.

## Registro de execução

Evidências desta rodada: `output/increment-release-20261101/`. Atualizar o checkpoint final com resultados efetivamente observados, distinguindo local, CI, imagem e implantação. Uma publicação de imagem não é comprovação de funcionamento em produção.
