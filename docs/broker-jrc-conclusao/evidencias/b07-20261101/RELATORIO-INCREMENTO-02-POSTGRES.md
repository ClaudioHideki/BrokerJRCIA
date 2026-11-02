# AUD-B07 — regressão do fence de polling em PostgreSQL isolado

Data: 2026-11-01. Complementa `RELATORIO-INCREMENTO-01.md`; não altera a conclusão de B07 parcial.

## Escopo e ambiente

Único arquivo de código acrescentado neste ciclo: `apps/api/tests/integration/qr-poll-fence.test.ts`. Nenhum helper compartilhado, configuração global, código produtivo, migration ou permissão foi alterado neste ciclo.

Execução contra o PostgreSQL exclusivo de laboratório já autorizado pela coordenação, em `127.0.0.1:15439`, com `TEST_DATABASE_ADMIN_URL`. O helper existente cria uma base de nome aleatório, executa migrations sob o lock global existente e elimina somente essa base ao encerrar. Não foram usados dados reais nem serviços externos. Não houve commit, push, publicação ou deploy.

## O que foi comprovado

1. O serviço real `getInstanceStatus` e o repositório PostgreSQL real capturam watermark/fingerprint persistidos. Somente o transporte do provider fica aguardando uma Promise controlada pelo teste.
2. Em outra transação `jrc_app`, o helper produtivo `persistConnectionFact` grava um novo fato `CONNECTED`, avançando watermark ou trocando fingerprint. Isso comprova a fronteira de persistência usada pelo webhook, não o ingresso HTTP completo nem a autenticação da engine.
3. O harness atribui `updated_at` de `.123100` e `.123900` para construir uma colisão determinística: PostgreSQL distingue os timestamps; JavaScript os lê no mesmo milissegundo. O teste verifica ambas as condições e confirma que o status permaneceu igual. O harness não depende da velocidade de execução para gerar a corrida.
4. Liberado o resultado antigo `DISCONNECTED`, o serviço conserva `CONNECTED` e os metadados mais recentes nos dois casos. Com clock capturado inalterado, o polling é aceito e conserva watermark/fingerprint.
5. Controle de mutação: um override limitado ao módulo do teste desativa apenas `isSameConnectionClock`; com o mesmo cenário, o serviço grava indevidamente `DISCONNECTED`. Esse controle comprova que os dados da fixture expõem o defeito anterior; não foi necessário reverter temporariamente código compartilhado.
6. A conexão de runtime usa diretamente `jrc_app`, sem superuser e sem BYPASSRLS. O teste verifica RLS e FORCE RLS ativos em `instances`, leitura de outro tenant invisível e `persistConnectionFact` rejeitado para instância estrangeira. O estado original permanece intacto.

## Execuções e evidências

Comando: `node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts apps/api/tests/integration/qr-poll-fence.test.ts --maxWorkers=1`, com `TEST_DATABASE_ADMIN_URL` apontando para o laboratório autorizado.

- `06-postgres-regression.txt`: preparação excedeu o limite inicial de 60 s durante a execução das migrations; cinco casos não executados. O orçamento de preparação foi ampliado para 180 s somente neste arquivo.
- `08-postgres-regression-retry.txt`: primeiro caso funcional aprovado; os outros quatro falharam porque minha fixture reutilizava nome de instância sujeito a unique. Fixture corrigida para nome e chave sintéticos únicos; nenhuma alteração produtiva foi necessária.
- `09-postgres-regression-final.txt`: **1 arquivo / 5 testes aprovados**, exit 0, duração **38,31 s**. Inclui casos positivos, negativos, controle de mutação e RLS descritos acima.
- `node node_modules/typescript/bin/tsc -b --pretty false`: sem diagnóstico, exit 0.
- `git diff --check -- apps/api/tests/integration/qr-poll-fence.test.ts`: exit 0.

## Limites preservados

Esta prova executa SQL, transações e RLS reais na fronteira de persistência e no serviço de polling. Não é prova de ordenação global entre origem, webhook e polling, nem cobre a engine/WhatsApp, geração real de sessão, todas as interleavings ou deadlocks de ingresso HTTP completo. A colisão temporal é construída pelo harness e não mede sua frequência operacional. A geração existente no fleet continua sendo da engine/binding, não uma geração de sessão WhatsApp atestada.

O teste é adicional à suíte unitária de 59 testes aprovada no incremento anterior. A suíte geral fica sob consolidação da coordenação; este relatório não afirma aprovação integral do checkout.
