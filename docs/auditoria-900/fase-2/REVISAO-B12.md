# Revisão independente B12 — replay e estatísticas de delivery

Revisão em 2026-10-29, branch `codex/broker-audit-fixes-20261029`, base informada `9e62ceaf3177979a68bc4985a93e25474de48487`. Revisão do working tree, sem alteração de código, commit, push, migration, serviço ou produção. O pacote `output/broker-phase2-20261029/B12-diff.txt` informado não estava presente; foram lidos os arquivos atuais e o diff de rotas/serviço. Journal, readiness, OpenAPI e helper `audit_corrections_catalogue_ready` são consolidação do executor principal.

## Resultado

**P1 do guard corrigido e revalidado offline; nenhum achado bloqueador aberto nesta revisão.** Não foi identificado defeito funcional bloqueador no replay durante a inspeção estática e os testes offline. Isso não comprova SQL executável, isolamento ou ausência de deadlocks em PostgreSQL: os oito testes reais foram apenas coletados, conforme a restrição de ambiente. O achado original e a correção estão preservados abaixo.

## Achado

### P1 — guard permite destino/usuário efetivos fora do laboratório declarado

Arquivo: `apps/api/tests/integration/partner-delivery-replay.test.ts:13-15`.

O guard valida `new URL(raw).hostname`, `username` e `pathname`, depois entrega a string original para `attendanceDatabase()`. O parser instalado de `pg-connection-string` aceita query params que prevalecem sobre partes dessa URL: `host` e `user`, por exemplo. Assim, `postgres://lab_admin@127.0.0.1/lab_admin?host=outside.invalid&user=postgres` passa as verificações novas, mas a configuração efetiva tem host `outside.invalid` e usuário `postgres`.

Reprodução exclusivamente offline, sem criar `Pool` nem resolver DNS:

```js
import {parse} from 'pg-connection-string';
const raw='postgres://lab_admin@127.0.0.1/lab_admin?host=outside.invalid&user=postgres';
const u=new URL(raw);
const guard=['127.0.0.1','[::1]'].includes(u.hostname)
  && decodeURIComponent(u.username).startsWith('lab_')
  && u.pathname.startsWith('/lab_');
const cfg=parse(raw);
// {guardPasses:true,effectiveHost:'outside.invalid',effectiveUser:'postgres',effectiveDatabase:'lab_admin'}
```

Impacto: com a flag exclusiva habilitada e essa configuração, `helpers/postgres.ts:31-32` cria o banco no destino efetivo e `helpers/attendance.ts:42` executa migrations. `infra/app/postgres/init-roles.sql` inclui `ALTER ROLE` globais. Portanto, o guard não garante a fronteira loopback/usuário lab descrita em `B12-IMPLEMENTACAO.md`. Não se trata de entrada HTTP do parceiro; é proteção contra configuração errada do executor de testes, com consequência potencialmente destrutiva no cluster errado.

Correção recomendada: rejeitar overrides de destino/identidade na query ou validar e utilizar uma configuração efetiva normalizada; manter o requisito de cluster exclusivo. Adicionar regressão offline para query params `host`, `user` e `port`, além de credenciais/hostname comuns, antes de qualquer teste de banco. O mesmo padrão está em `apps/api/tests/integration/media-custody.test.ts:15` e deve ser tratado na consolidação.

## Conformidade do produto por inspeção

- **Autoridade mínima:** rotas novas usam `authenticateRequest`, `webhooks:manage` e API_KEY obrigatória (`apps/api/src/http/routes/partner-webhooks.ts:35-44`). A função interna é revogada para todos os papéis runtime; apenas replay/stats recebem EXECUTE para `jrc_app` (`0077:94-95,146-148,169-171`). Nenhum grant de UPDATE das novas colunas ou escrita no ledger foi adicionado ao runtime.
- **Chave atual e control-bound:** `partner_delivery_require_authority` obtém tenant da transação, usa `tenant_is_active` e trava a chave `FOR UPDATE`; depois consulta revogação, expiração por `clock_timestamp()`, scope e inexistência de qualquer binding (`0077:78-92`). O `FOR UPDATE` conflita com o lock de FK da inserção de binding; a organização é protegida pelo SHARE já existente em `0011:52-60`. As revalidações após os locks do replay e antes do retorno estão em `0077:125,141`.
- **Intenção e reset condicional:** a chave serializa intents do mesmo autor antes de consultar o ledger; intenção divergente retorna conflito antes do lookup do delivery (`0077:103-114`). IDs são preservados por FKs compostas, hash canônico e reset do próprio delivery, sem alterar event/endpoint (`0077:16-20,107,129-138`). Uma repetição encontra o ledger e não reseta um worker em andamento. A unicidade por delivery/ciclo protege duas chaves concorrentes para o mesmo delivery.
- **Contadores/evidência:** backfill inicial usa `attempts` existente (`0077:3-5`); ledger preserva tentativas/erro/ciclo (`0077:14-17,134-135`). O trigger acumula apenas incrementos de attempts e exige ledger coerente para reset de FAILED (`0077:48-74`). Runtime não consegue reabrir FAILED ou reduzir attempts pelo UPDATE antigo.
- **Ordem de locks e revogação:** replay trava endpoint, evento e delivery nessa ordem (`0077:119-124`). Revogação do endpoint existente atualiza endpoint antes de deliveries (`service.ts`, `revoke`); prune existente apaga evento antes do cascade de deliveries (`0070:128-132`). A leitura estática não revelou inversão dessas ordens no caminho revisado. Endpoint ACTIVE e retenção lógica são verificados depois dos locks pertinentes (`0077:120,126-127`). Essa análise não substitui teste concorrente real.
- **Completion antigo:** worker existente liquida somente status RUNNING, lease UUID e expiração correspondente (`apps/api/src/modules/partner-events/worker.ts:45-49`). O replay não reutiliza lease, e o próximo claim gera UUID novo; completion antigo não encontra o ciclo novo.
- **RLS/lifecycle/prune:** ledger com FORCE RLS, policy por tenant para `jrc_app`, policy explícita migrator, REVOKE amplo e apenas SELECT runtime (`0077:22-31`). Ledger imutável para runtime e UPDATE recusado inclusive ao migrator (`0077:33-44`). FKs CASCADE levam o ledger junto do evento/delivery/endpoint; catalogue inclui a tabela. O purge organizacional existente calcula a ordem por FKs e o purge de canal chega pelo evento/channel. Validade operacional dessas cascatas ainda não executada.
- **Ausência de WhatsApp send:** as funções novas só inserem ledger e atualizam delivery HTTP; stats consulta metadados agregados. Não há escrita em mensagens, messaging outbox ou provider send no caminho novo. Replay continua sujeito à deduplicação do receptor por organização/evento em ACK perdido.
- **Estatísticas:** consulta mantém tenant explícito e retenção de 30 dias, sem ler payload, URL ou segredo (`0077:154-166`). `lifetimeAttempts` é cumulativo dos ciclos das deliveries ainda retidas, não histórico eterno.

## Evidência executada

1. `npx vitest run apps/api/src/modules/partner-events apps/api/tests/http/partner-webhooks.test.ts apps/api/tests/http/partner-delivery-replay.test.ts --maxWorkers=1`: **5 arquivos, 31 testes PASS**, 7,29 s. Serviço/HTTP utilizam fronteiras SQL simuladas; assinatura/retry/lease existentes também incluídos.
2. `npx vitest list apps/api/tests/integration/partner-delivery-replay.test.ts --config vitest.integration.config.ts --maxWorkers=1`: **8 testes coletados**, sem executar hooks ou abrir banco.
3. `git diff --check -- apps/api/src/modules/partner-events/service.ts apps/api/src/http/routes/partner-webhooks.ts`: PASS.
4. Reprodução do parser acima: **guardPasses true; effectiveHost outside.invalid; effectiveUser postgres**. Nenhuma rede ou credencial real utilizada.

## Limites e qualidade da cobertura

Os testes preparados verificam replay concorrente com mesmo intent, ACK perdido após claim, ciclos acumulados, conflito/cross-tenant, PENDING, evento expirado, endpoint revogado, completion antigo, SQL fences, agregados, chave já revogada/expirada/control-bound, expiração após espera de delivery lock, revogação concorrente do endpoint e prune sequencial preservando outro tenant.

Não há cenário preparado específico para inserção concorrente de control-binding, revogação/scope da chave enquanto o replay espera o lock da chave, prune concorrente, namespaces de intents entre duas API keys, nem purge completo de organização/canal com ledger. As condições correspondentes foram inspecionadas, sem atribuir a isso status de prova runtime. O teste de não envio compara quantidade de mensagens, mas não inspeciona outboxes; a ausência de send é adicionalmente evidência estática.

PostgreSQL real permanece **NÃO EXECUTADO**; não houve validação de capacidade 900, receptor CCLX, comportamento live ou produção. Typecheck/build/suíte geral e contratos centrais são responsabilidade da consolidação, não executados nesta revisão.

## Adendo — revalidação da correção P1

Em 2026-10-29, a correção do executor principal foi revisada sem alterar implementação. O novo `apps/api/tests/integration/helpers/exclusive-lab.ts:2-11` rejeita query string/fragmento, restringe o protocolo a `postgres:`/`postgresql:`, exige host loopback literal e usuário/database com padrão `lab_` estrito, além da flag exclusiva explícita. A rejeição de toda query remove a possibilidade de `pg-connection-string` sobrepor `host`, `user` ou `port` depois do guard. Os dois suites chamam o helper antes de `attendanceDatabase()`: `partner-delivery-replay.test.ts:13-14` e `media-custody.test.ts:14-15`.

Reexecução independente: `npx vitest run apps/api/tests/unit/exclusive-lab.test.ts --maxWorkers=1` — **1 arquivo, 12 testes PASS**, 923 ms. Inclui o caso exato reproduzido, nome de parâmetro codificado, opção SSL, fragmento, host remoto, usuário/database fora do padrão, protocolo HTTPS, casos válidos IPv4/IPv6 e ausência de URL/flag. O RED anterior (5 falhas/7 passes) foi informado pelo executor principal; esta revalidação confirmou diretamente o estado GREEN. Nenhuma conexão, DNS, serviço, migration ou PostgreSQL foi executado.

**P1 encerrado para o desvio reproduzido.** O helper declara corretamente que a validação de URL não prova exclusividade ou descartabilidade do cluster; a flag continua sendo uma afirmação explícita do operador. As demais limitações de prova SQL/lifecycle/concorrência acima permanecem.
