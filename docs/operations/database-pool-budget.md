# Orçamento dos pools PostgreSQL — C1a

Este corte explicita e permite configurar os pools existentes. Não mede nem aumenta a capacidade do servidor; não altera processamento, concorrência, shards, leases, intervalos, statement_timeout ou isolamento por role/tenant.

Cada perfil aceita três variáveis: `<PERFIL>_DB_POOL_MAX`, `<PERFIL>_DB_POOL_CONNECT_TIMEOUT_MS` e `<PERFIL>_DB_POOL_IDLE_TIMEOUT_MS`. A configuração usa `loadDatabasePoolBudget` antes de construir o pool. Somente valores inteiros decimais são aceitos; valor ausente mantém o default, enquanto valor vazio/inválido falha indicando o nome da variável, sem imprimir ambiente/DSN/segredos.

| Perfil | Pool/processo | Max default | Conexão ms | Idle ms |
| --- | --- | ---: | ---: | ---: |
| API_APP | API, role jrc_app | 10 | 0 | 10000 |
| API_AUTH | API, role jrc_auth | 10 | 0 | 10000 |
| API_PLATFORM | API platform e lifecycle compartilham este pool, quando configurados | 4 | 5000 | 10000 |
| MESSAGING_WORKER | Mensageria, role jrc_app | 4 | 5000 | 10000 |
| MESSAGING_AUTH | Controle Chatwoot do worker, role jrc_auth, quando habilitado | 2 | 5000 | 10000 |
| AUTOMATION_WORKER | Execução de automações, role jrc_app | 4 | 5000 | 10000 |
| AUTOMATION_IO_WORKER | IO de automações, role jrc_app | 4 | 5000 | 10000 |
| SCHEDULER_WORKER | Scheduler, role jrc_app | 2 | 5000 | 10000 |
| LIFECYCLE_WORKER | Lifecycle worker, role jrc_lifecycle | 2 | 5000 | 10000 |

Os defaults explícitos preservam o runtime anterior: app/auth herdavam max 10, timeout de conexão desativado e idle 10000 do `pg-pool` instalado; os demais já configuravam max/timeout de conexão. Todos herdavam idle 10000. O pool do lifecycle na API já é o pool platform; não existe um segundo pool para somar nesse processo.

Limites de entrada por pool: max 1..100; conexão 0..120000 ms; idle 0..3600000 ms. São guardas de configuração, não capacidade homologada nem orçamento global. Zero desativa o respectivo timeout, preservando o comportamento default da conexão API; timeout de conexão finito limita espera/abertura, enquanto idle remove apenas conexões ociosas. Statement_timeout continua separado e preservado.

Exemplo de configuração de uma réplica API:

```env
API_APP_DB_POOL_MAX=10
API_APP_DB_POOL_CONNECT_TIMEOUT_MS=0
API_APP_DB_POOL_IDLE_TIMEOUT_MS=10000
API_AUTH_DB_POOL_MAX=10
API_AUTH_DB_POOL_CONNECT_TIMEOUT_MS=0
API_AUTH_DB_POOL_IDLE_TIMEOUT_MS=10000
```

## Soma por réplicas e reservas

`max` é o limite potencial de um pool em um processo. Ele não cria todas as conexões imediatamente nem mede uso. Multiplique cada pool pelo número de réplicas que o instanciam e conte réplicas antigas e novas simultâneas durante rollout.

```text
Broker pools = R_API × (API_APP + API_AUTH)
             + R_API_PLATFORM × API_PLATFORM
             + R_MESSAGING × MESSAGING_WORKER
             + R_MESSAGING_CONTROL × MESSAGING_AUTH
             + R_AUTOMATION × AUTOMATION_WORKER
             + R_IO × AUTOMATION_IO_WORKER
             + R_SCHEDULER × SCHEDULER_WORKER
             + R_LIFECYCLE × LIFECYCLE_WORKER
```

`R_API_PLATFORM` e `R_MESSAGING_CONTROL` contam apenas réplicas com o componente ativo. Use os valores configurados em cada grupo; réplicas com configurações diferentes exigem somas separadas. Somar apenas um DATABASE_URL ou dividir o orçamento por tenant não cobre os pools de autenticação/plataforma.

O operador deve inventariar `max_connections`, conexões reservadas pelo PostgreSQL, limites por role, réplicas/rollout, migrações/comandos efêmeros, backups, monitoramento, outros serviços e margem de recuperação. Evolution ou outros bancos no mesmo servidor PostgreSQL também consomem esse orçamento. O total potencial de pools mais essas conexões/reservas deve caber no orçamento definido pelo operador. Nenhum teto global, reserva numérica ou capacidade de empresas/canais foi inferido neste corte.

Comandos de bootstrap, criação de tenant/canal/admin, migração e operational-status permanecem com suas opções atuais e devem entrar no inventário se executados. Telemetria de espera/uso de pool, carga, distribuição e implantação permanecem em C1/C0 e posteriores.

## Aplicação no Dokploy

O Compose atualizado encaminha as 27 variáveis no bloco `x-runtime`, com fallback para cada default da tabela. API, mensageria, automação, IO e scheduler conservam a herança desse bloco. Cada processo aplica somente os perfis dos pools que instancia. O lifecycle worker conserva seu ambiente e DSN `jrc_lifecycle` dedicados e encaminha somente suas três variáveis de pool, sem herdar DSNs app/auth nem os demais perfis.

O fallback usa `${VAR-default}`: somente uma variável ausente recebe o default. Um valor explicitamente vazio é encaminhado e rejeitado pelo helper, assim como valores inválidos ou fora dos limites. Para usar o default, remover a variável do Environment em vez de cadastrá-la vazia.

Usar o Compose atualizado e uma imagem que contém C1a. No Environment da aplicação Compose do Dokploy, cadastrar somente os valores desejados após calcular o orçamento por réplicas; os exemplos no `.env.example` são comentados para manter os defaults quando omitidos. Conferir no Preview Compose os valores resolvidos das chaves de pool e sua entrega aos serviços correspondentes, evitando expor DSNs ou segredos nas evidências.

Salvar variáveis no Dokploy não modifica o ambiente de containers existentes. Aplicar o Compose atualizado e recriar os serviços API/workers na implantação aprovada; atualizar somente a imagem ou manter um Compose antigo não adiciona esses encaminhamentos. Este corte verifica o Compose local com ambiente sintético, sem realizar implantação ou comprovar a configuração em produção.

## Ledger local

- Plano escrito antes da implementação.
- RED: `npm test -- apps/api/tests/unit/database-pool-budget.test.ts` — 33 falhas funcionais, exit 1, 8,14 s, início 16:45:46 de 2026-10-07 (America/Sao_Paulo). Confirmou ausência de defaults explícitos, overrides e validação.
- GREEN final: `npm test -- apps/api/tests/unit/database-pool-budget.test.ts apps/api/tests/unit/config.test.ts apps/api/tests/unit/messaging-worker-config.test.ts apps/api/tests/unit/operational-worker-pagination.test.ts apps/api/tests/unit/app.test.ts` — 5 arquivos/69 testes aprovados (35 no teste novo), exit 0, 19,38 s, início 16:50:25 de 2026-10-07 (America/Sao_Paulo). Inclui os dois testes adicionais da configuração API. Os testes de pool usam construção sem acquire/query, com totalCount zero; não abrem conexão SQL.
- Strict compile focado: `node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --verbatimModuleSyntax --target ES2023 --module NodeNext --moduleResolution NodeNext --types node --skipLibCheck apps/api/src/db/pool-budget.ts apps/api/src/db/pools.ts apps/api/src/config/env.ts apps/api/tests/unit/database-pool-budget.test.ts` — exit 0. TS7 requer `--ignoreConfig` para lista explícita de arquivos. App/workers e demais referências ficam para o build global da raiz.
- Diff da integração revisado: somente defaults/config/spreads dos pools e imports; DSNs, roles e statement_timeout preservados. `git diff --check` no escopo passou, exit 0.
- Sem dependências, DB, produção, commit/push ou suíte completa. A raiz fará build e verificação global.

### C1a2 — Compose

- Plano estendido antes do teste/implementação para encaminhar as variáveis no Dokploy. Ownership limitado ao Compose, exemplos, teste e documentação; DSNs, roles, imagens, volumes e demais defaults preservados.
- A primeira tentativa de RED não iniciou os testes: o sandbox bloqueou o esbuild ao ler um diretório ancestral. O mesmo comando foi repetido fora do sandbox; esse erro de infraestrutura não conta como RED funcional.
- RED funcional: `npm test -- tests/database-pool-compose.test.mjs --maxWorkers=1` — dois testes falharam por ausência dos valores de pool no Compose resolvido, exit 1, 21,11 s, início 17:34:33 de 2026-10-07 (America/Sao_Paulo).
- GREEN inicial: `npm test -- tests/database-pool-compose.test.mjs tests/dokploy-compose-config.test.mjs apps/api/tests/unit/database-pool-budget.test.ts --maxWorkers=1` — três arquivos/41 testes aprovados, exit 0, 12,34 s, início 17:39:46.
- RED adicional com o comando do teste novo: um teste falhou funcionalmente e dois passaram porque `:-` trocava um override vazio pelo default, exit 1, 16,34 s, início 17:41:58. Ajuste para `${VAR-default}` mantém o contrato de rejeição de vazio do helper.
- GREEN final com os três arquivos e um worker: 42 testes aprovados, exit 0, 18,10 s, início 17:43:38. O teste novo resolve `docker compose config` com ambiente sintético e `.env.example` explícito; confere os 27 fallbacks, overrides por serviço, herança do runtime, lifecycle dedicado e vazio rejeitado por campo. Não inicia containers nem conexão SQL.
- `git diff --check` no escopo passou, exit 0. Sem dependências, banco, build global, produção ou commit; verificação global permanece com a raiz.
