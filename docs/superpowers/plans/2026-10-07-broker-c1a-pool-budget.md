# Broker C1a — orçamento explícito dos pools PostgreSQL

> **For agentic workers:** Use superpowers:executing-plans e superpowers:test-driven-development; manter este corte isolado, sem commit.

**Goal:** Configurar max/conexão/ociosidade de pools por processo, com validação e preservação dos defaults vigentes.
**Architecture:** Um helper puro resolve perfis de pool e variáveis de ambiente limitadas. API e workers aplicam somente essas três opções aos pools existentes, preservando DSNs, roles, statement_timeout e processamento.
**Tech Stack:** TypeScript/Zod/pg/Vitest existentes, sem dependências, DB ou produção.
**Spec:** C1 de `2026-10-06-broker-capacidade-operacao.md`; pools contam por réplicas e com reservas do banco.

## Escopo e arquivos

- Novo `apps/api/src/db/pool-budget.ts`; modificar `db/pools.ts`, `config/env.ts` e as construções de pools de `app.ts`.
- Comandos messaging/automation/automation-io/scheduler/lifecycle: somente construção/configuração dos pools.
- Novo teste unitário `database-pool-budget.test.ts` e `docs/operations/database-pool-budget.md`.
- Defaults observados no pg-pool instalado: API app/auth 10/0/10000; platform 4/5000/10000; workers 4/5000/10000, exceto scheduler/lifecycle/auth de controle 2/5000/10000. Valores significam max/conexão ms/idle ms. API platform e lifecycle compartilham o mesmo pool.
- Limites por pool: max 1..100, conexão 0..120000 ms e idle 0..3600000 ms. Zero conserva sem limite de conexão/remoção por ociosidade; não é promessa de capacidade.
- Não editar módulos messaging, readiness, schema, routes, Studio ou lock; não alterar concorrência/shards/leases, telemetria, S3 ou distribuição. A extensão C1a2 abaixo permite somente encaminhar as variáveis de pool no Compose.

## Tarefa

- [x] Escrever testes RED funcionais para defaults, perfis independentes, valores customizados, limites/erro de campo e pools API sem conexão.
- [x] Rodar teste novo para comprovar falhas anteriores à implementação.
- [x] Implementar helper único e integração nas construções existentes; preservar comportamento default.
- [x] GREEN: novo teste e regressões de config/paginação/worker config; strict compile focado e diff check.
- [x] Documentar cálculo por réplicas/reservas e ledger, sem alegar aumento de capacidade. Raiz executará build/global.

## C1a2 — encaminhamento no Dokploy

**Problema:** o Compose declara `environment` explicitamente; cadastrar as novas variáveis no Dokploy não as encaminha aos processos.

**Ownership:** somente `infra/dokploy/compose.yaml`, `infra/dokploy/.env.example`, `tests/database-pool-compose.test.mjs`, este plano e `docs/operations/database-pool-budget.md`. Preservar imagens, volumes, DSNs, roles e todos os demais defaults.

**Interfaces:** 27 variáveis, nove perfis com max/conexão/idle, em `x-runtime`, com os defaults canônicos do helper. API/messaging/automation/IO/scheduler mantêm `*runtime`. Lifecycle mantém ambiente dedicado e recebe somente suas três variáveis próprias.

**Ruling:** preservar a separação do lifecycle em vez de fazê-lo herdar `*runtime` — seu DSN/role dedicados não devem receber DSNs app/auth nem outros perfis; o custo é repetir três encaminhamentos, verificados contra os defaults canônicos.

**Ruling:** fallback somente para variável ausente (`${VAR-default}`), preservando valores vazios para a validação do runtime — `${VAR:-default}` ocultaria erro explícito de configuração; o custo é que um campo vazio no Dokploy requer correção ou remoção para iniciar o processo.

- [x] RED: criar teste que resolve o Compose com valores sintéticos, verifica todos os encaminhamentos/defaults e herança/ownership; rodar apenas esse teste com `--maxWorkers=1`. Esperado: falhas funcionais por variáveis ausentes nos ambientes resolvidos. Confirmado: dois testes falharam funcionalmente, exit 1, em 17:34:33 de 2026-10-07.
- [x] RED adicional: valor explicitamente vazio chega ao processo e é rejeitado pelo helper com o nome da variável. Esperado: falha funcional quando `:-` troca o valor vazio pelo default. Confirmado: um teste falhou funcionalmente e dois passaram, exit 1, em 17:41:58 de 2026-10-07.
- [x] GREEN: adicionar os 27 encaminhamentos e os três próprios do lifecycle; exemplos comentados no `.env.example`; documentar aplicação no Dokploy sem alegar implantação.
- [x] Executar teste novo, regressão de Compose e teste canônico de pools com um worker. Esperado: todos aprovados, sem iniciar containers ou conexão SQL. Confirmado: três arquivos/42 testes aprovados, exit 0, 18,10 s, início 17:43:38. Sem build global, DB, commit ou produção; verificação global permanece com a raiz.
- [x] Registrar RED/GREEN e diff check no ledger da documentação e entregar os cinco arquivos à raiz.
