# Revisão independente — B05, B07 e B13

Revisão local de 29/10/2026 sobre o pacote `B05-B07-B13-diff.txt`, base `9e62ceaf3177979a68bc4985a93e25474de48487`, incluindo os arquivos novos `qr-connection-order.ts`, seu teste unitário e migration `0076_qr_connection_watermark.sql`. Critério: `AGENTS.md` e `PLANO-IMPLEMENTACAO.md` desta fase. Nenhum código foi alterado por esta revisão. B03, sua migration 0075 e B12 estão fora do escopo de ownership.

## Parecer após revisão das correções

**Os três achados iniciais e os três pontos do adendo central estão fechados no código local revisado.** Journal e integração de readiness foram incorporados e revisados localmente. Não há achado bloqueante aberto neste escopo. A prova não inclui PostgreSQL real, execução da engine nem produção. As seções iniciais preservam a rastreabilidade dos achados.

## Resultado inicial

B05 e B13 atendem ao incremento local revisado, dentro das fronteiras abaixo. B07 requer correção dos dois achados de implementação e reavaliação do relógio da origem antes de ser considerado encerrado. A coordenação confirmou os dois achados de implementação e preparará regressões; esta seção registra a primeira leitura, não antecipa a conclusão da revisão das correções.

### 1. P1 — o caminho fleet ainda promove SHARE para UPDATE da instância

`apps/api/src/modules/messaging/qr-service.ts:193-194` executa `authority.assert` / `fleet.assert` antes do novo `persistConnectionFact` em `:216`. Essas chamadas alcançam `evolution_assert_binding`, que toma `instances FOR SHARE` em `apps/api/drizzle/migrations/0056_evolution_engine_fleet.sql:186`. Depois, `qr-connection-order.ts:17-20` solicita `FOR UPDATE` sobre a mesma instância.

Cenário: duas transações autenticadas via fleet obtêm SHARE compatível sobre a mesma instância e ambas tentam promover para UPDATE. Cada uma espera a outra liberar SHARE; PostgreSQL precisa abortar uma por deadlock. O novo posicionamento antes do lock do canal elimina uma inversão, mas não elimina esse upgrade anterior. O teste concorrente adicionado em `qr-chatwoot-storage.test.ts` constrói o serviço sem `fleet`, portanto não cobre o caminho que contém SHARE. Corrigir a aquisição inicial do lock sem enfraquecer a revalidação da autoridade após a espera e adicionar regressão que percorra o caminho fleet real.

### 2. P2 — os campos Drizzle foram adicionados à tabela errada

`apps/api/src/db/schema.ts:298-299` declara `connectionObservedAt` e `connectionBindingFingerprint` em `providerAccounts`. A migration 0076 e o serviço persistem esses campos em `instances`; a declaração de `instances` não contém os novos campos. Isso deixa o contrato declarativo diferente do banco e pode produzir SQL para colunas inexistentes ao usar `providerAccounts` pelo ORM ou derivar migrations futuras. Mover as declarações para `instances` e cobrir sua localização no schema.

### 3. P2 — o filtro de futuro assume um relógio UTC que a origem fixada não garante

`apps/api/src/modules/messaging/qr-events.ts:96` rejeita relógios maiores que o relógio do broker mais cinco minutos. Porém `upstream/evolution-api/src/api/services/channel.service.ts:442-445` subtrai `getTimezoneOffset()` de `Date.now()` e emite `toISOString()`: a hora local recebe sufixo Z. Com engine em UTC+1, cada evento real parece uma hora no futuro e todos os `connection.update` passam a falhar. Com UTC-3, o relógio fica três horas atrás; uma mudança de fuso da engine pode ainda mudar a ordenação sem mudar o fingerprint de binding.

O cenário é inferido diretamente do código da origem, sem execução da engine. O fuso atual de produção não foi consultado. Tratar explicitamente a semântica desse timestamp/clock domain ou registrar e validar a exigência de UTC na configuração atestada antes de afirmar compatibilidade operacional; adicionar fixture para a semântica real da origem. Não alterar o submódulo fixado nesta tarefa.

## Critérios atendidos e limites

- **B05:** envelopes `data`, `content`, `message`, `text`, identificadores e assinatura recebem redaction estrutural; arrays circulares passam pelo detector antes da recursão; erros não preservam message/stack, tipos são limitados e status HTTP é validado. A regressão Fastify continua preservando metadados operacionais e omitindo os canários. O logger não é um detector de segredos em texto livre; as mensagens de log de produção revisadas são literais sob controle JRC. Nada aqui comprova sanitização do processo externo Evolution.
- **B07:** o filtro de watermark ocorre antes de `observeQrIdentityScope`, resolução de identidade, observadores de grupos e Chatwoot. Dentro do mesmo fingerprint, timestamp antigo, empate e legado após watermark são descartados. Novo binding autenticado inicia outro domínio; o fingerprint é HMAC dos metadados do engine, sem segredo ou identidade em claro. A migration é aditiva. A robustez de concorrência e a semântica da origem estão limitadas pelos achados acima.
- **B13:** history import passa a usar o helper com os mesmos defaults (`max=2`, aquisição 5000 ms, idle 10000 ms) e conserva o teto anterior 8. O planejador inclui partner/history/source/platform/control e soma réplicas transitórias antes de calcular folga. Entradas inválidas de rollout são rejeitadas; o relatório reconstrói campos permitidos, sem DSNs, e continua `capacityValidated=false`. Não há aumento de quotas, pools ou limites comerciais. Fontes históricas próprias continuam dependentes do inventário informado pelo operador; não houve descoberta nem medição de capacidade real.

## Verificação executada

Comando offline:

```text
node node_modules/vitest/vitest.mjs run packages/security/tests/redaction.test.ts packages/security/tests/logger.test.ts apps/api/tests/unit/qr-connection-order.test.ts apps/api/tests/unit/qr-events.test.ts apps/api/tests/unit/database-pool-budget.test.ts apps/api/tests/unit/fastify-logger-redaction.test.ts tests/capacity-report.test.mjs --maxWorkers=1
```

Resultado: **6 arquivos, 109 testes aprovados**, duração 14,25 s. `packages/security/tests/logger.test.ts` não existe; o runner selecionou os outros seis arquivos. Não foi criada conexão PostgreSQL nesses testes. Testes de integração PostgreSQL, execução da migration, RLS e locks reais: **NÃO EXECUTADOS**, pois não há cluster lab disponível. Nenhum DSN foi utilizado.

## Consolidação pendente, separada dos achados

Na primeira leitura o journal terminava em 0074. A coordenação esclareceu que o registro conjunto de 0075/B03, 0076/B07 e 0077/B12 está reservado à consolidação. Portanto isso é uma pendência explícita, não um defeito atribuído ao incremento já consolidado. Antes da entrega, conferir que o migrator e a verificação de readiness realmente incluem 0076; somente adicionar o arquivo SQL não o torna executável pelo migrator Drizzle.

## Revisão das correções

Revisão pontual executada após os ajustes da coordenação:

- **Achado 1 fechado:** `qr-service.ts` toma `instances FOR UPDATE` após a autenticação Bearer e antes de qualquer assert de autoridade no caminho `connection.update`. Os asserts permanecem depois da aquisição, preservando revalidação da autoridade após uma espera. O teste percorre `createQrMessagingService.ingest` com uma autoridade simulada que exige o lock prévio. Ele prova a ordem de chamadas; não executa a função SQL nem reproduz deadlock em PostgreSQL real.
- **Achado 2 fechado:** ambos os campos estão agora em `instances`; foram removidos de `providerAccounts`. A regressão verifica a localização da declaração do watermark.
- **Achado 3 fechado:** foi removida a comparação com o wall clock do broker. A validação ISO/calendário é mantida; uma fixture com timestamp uma hora adiante é aceita e a comparação continua estritamente dentro do fingerprint autenticado. Fuso/relógio da origem deve permanecer estável no mesmo domínio; não se afirma que esse timestamp seja UTC global. A documentação operacional dessa fronteira será consolidada pela coordenação.

Verificação final independente, com os seis arquivos existentes do comando acima (sem o nome inexistente `logger.test.ts`): **6 arquivos, 112 testes aprovados**, duração 16,90 s. Nenhum DSN ou serviço externo utilizado. Integração PostgreSQL, RLS/locks reais e execução da migration continuam **NÃO EXECUTADOS**. A aprovação local não deve ser descrita como homologação de PostgreSQL real, engine externa ou produção.

## Adendo — integração central de migrations e readiness

Escopo adicional solicitado no fechamento: `audit-corrections-runtime-schema.ts`, composição em `runtime-schema.ts`, declarações ORM, journal 0075–0077 e `audit_corrections_catalogue_ready()` ao final de 0077. Revisão de código e metadados locais, sem conexão a servidor.

**Consistência nominal:** o journal registra 0075/0076/0077 em ordem; o baseline é `0077_partner_delivery_replay`; os nomes de tabelas, políticas, funções, triggers, tipos de trigger e permissões nominais exigidos pela nova readiness correspondem às migrations. `audit_corrections_catalogue_ready()` é SECURITY DEFINER, propriedade do migrator, com search_path fixo, EXECUTE exclusivo do app entre as roles de runtime e retorno booleano sobre as duas entradas do catálogo privado. A verificação composta chama essa função somente após o gate estrutural. Não concede ao app leitura direta do catálogo ou do journal. As novas tabelas, colunas, uniques e FKs têm representação ORM correspondente.

Na primeira leitura do adendo foram comunicadas à coordenação estas lacunas:

1. **P2 — condição/colunas dos triggers não são verificadas:** a nova readiness compara nome, função, enabled e tgtype, mas não exige `tgqual IS NULL` e `tgattr` vazio. Um trigger de custódia recriado com `WHEN(false)` ou o fence de tentativas recriado como `UPDATE OF status` conserva os atributos verificados e pode passar no gate sem proteger todas as operações pretendidas. As migrations nominais criam triggers incondicionais corretos; a lacuna é a detecção de deriva.
2. **P2 — ACL de coluna fica fora do gate:** os checks da nova readiness usam privilégios de tabela e ACL de tabela, sem os checks de privilégios por coluna já usados em `partner-api-runtime-schema.ts`. Um grant adicional de coluna a uma role proibida não necessariamente implica privilégio da tabela toda e pode não tornar o schema unready. Isso não é evidência de concessão indevida pelas migrations nominais.
3. **Observação de consistência ORM:** o schema declarativo ainda não reproduz os checks SQL do fingerprint/clock em instances, de não negatividade de lifetime/replay e de formato/comprimento/ausência de URI em storage_object_id. As constraints existem nas migrations; a diferença importa para evolução futura por geração do schema, não enfraquece o banco migrado neste incremento.

Validação offline adicional: `audit-corrections-readiness.test.ts` **2/2 aprovados**. `readMigrationFiles` carregou **77 migrations**, para **77 entradas do journal**, com índices contínuos, timestamps crescentes e todos os arquivos presentes; a cauda é exatamente 0075/0076/0077. Os testes existentes de readiness inspecionam o SQL gerado e simulam respostas, portanto não validam a execução SQL contra catálogos reais. PostgreSQL, aplicação das migrations, RLS/ACL e triggers reais continuam **NÃO EXECUTADOS**.

### Fechamento do adendo central

Revisão pontual posterior confirmou as três correções:

- A nova readiness exige triggers sem condição (`tgqual IS NULL`) e sem restrição a colunas (`tgattr` vazio), além de lifecycle policy permissiva com comando `*`.
- O gate inspeciona privilégios por coluna para as roles proibidas e mantém os privilégios de INSERT do app limitados ao contrato de cada tabela, sem UPDATE/REFERENCES adicionais.
- O schema ORM agora declara os checks de fingerprint e clock, contadores não negativos e storage object, correspondendo às expressões e nomes SQL apontados no adendo.

**Pontos do adendo fechados; sem novo achado bloqueante na integração central revisada.** A pendência histórica de registro das migrations está resolvida: os arquivos 0075–0077 entram na leitura real do migrator e no baseline de readiness.

Validação final independente: `node node_modules/vitest/vitest.mjs run apps/api/tests/unit/audit-corrections-readiness.test.ts apps/api/tests/unit/qr-connection-order.test.ts --maxWorkers=1` — **2 arquivos, 10 testes aprovados**, sendo quatro da nova readiness. Duração 8,78 s. Essa regressão prova composição estrutural e declarações locais; **não comprova execução SQL, aplicação de migrations, RLS/ACL ou concorrência no PostgreSQL real**, que permanece indisponível. Nenhuma conexão de servidor foi tentada.
