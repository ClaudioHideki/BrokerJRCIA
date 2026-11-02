# Revisão independente B03 — custódia de mídia

Data: 29/10/2026. Revisão de conformidade e qualidade, somente leitura do código; este relatório é o único artefato escrito pelo revisor. Worktree `image-release-20260924`, branch `codex/broker-audit-fixes-20261029`, HEAD `9e62ceaf3177979a68bc4985a93e25474de48487` e alterações locais do B03. Foram lidos `AGENTS.md`, tarefa 2 de `PLANO-IMPLEMENTACAO.md`, `B03-IMPLEMENTACAO.md`, o diff fornecido e os arquivos novos de contrato, migration, serviço, HTTP e testes.

**Parecer final: sem achados acionáveis abertos após correção e rechecagem do P1 abaixo.** A fundação de recibos/KEEP está implementada e os testes offline passaram; não há prova de custódia física nem de comportamento PostgreSQL real. Nenhum acesso a DBENV, serviços, produção, LAB2, storage ou CCLX; nenhuma migration aplicada, commit, push ou deploy.

## Achado corrigido durante a revisão

### [P1 — FECHADO] Revalidar expiração da emissora depois da espera ao delegar `media:archive`

**Local original:** `apps/api/src/modules/api-keys/service.ts:217-224`, com extensão do scope no mesmo arquivo, linha 127 (`requestedPartnerScopes`). A descrição seguinte registra o snapshot inicial; a correção atual está nas linhas 215-244.

O novo scope passa pelo caminho de delegação existente, mas sua checagem usa `expires_at > $3`, onde `$3` é `now()` capturado no processo antes de executar o SELECT com `FOR SHARE`. Depois de obter o lock, o serviço apenas testa se recebeu uma linha e insere a filha. Não há nova leitura da autoridade com o relógio atual do banco após essa espera nem depois de possíveis esperas do INSERT/audit.

**Cenário:** a chave autenticada tem `api_keys:manage` e `media:archive` e vence em T1. Em T0, ainda válida, pede uma filha com `media:archive` e `expiresAt: null`. A emissão espera por lock na chave (ou mais tarde na admissão da organização/INSERT), o relógio passa de T1 e o lock é liberado sem alteração dos campos da emissora. A comparação continua usando T0; a filha é criada mesmo com emissora expirada. A filha possui identidade própria e pode registrar recibos posteriormente. Os rechecks corretos do serviço de custódia não corrigem essa delegação consumada.

**Evidência executada offline:** foi importado o serviço atual a partir de sua fonte, removendo tipos apenas em memória com `node:module.stripTypeScriptTypes`; transação/repositório foram simulados. O mock avaliou o parâmetro de tempo da query ainda válido, avançou o relógio para depois da expiração antes de retornar e observou a emissão. Saída sintética, sem segredo:

```json
{"issuerExpiredAtInsert":true,"issuedArchive":true,"childHasNoExpiry":true,"inserts":1,"checks":1}
```

Isso comprova a ausência de rechecagem no fluxo de serviço; não é um ensaio de locks PostgreSQL. O trigger `tenant_api_key_admission` existente valida a organização/quota, não a autoridade da emissora, portanto não fornece a checagem ausente. A lacuna antecede B03 para outros scopes, mas `media:archive` é novo e sua delegação herda o problema agora.

**Correção esperada:** manter o lock da emissora e usar autoridade atual com `clock_timestamp()` em consulta posterior à aquisição do lock; revalidar antes de concluir a transação após INSERT/audit se estes puderem esperar. Acrescentar regressão que faça a emissora vencer durante a espera e exija rollback da filha, mantendo revogação e remoção de scope protegidas. O relatório de implementação deve refletir essa fronteira enquanto a correção não existir.

**Fechamento verificado independentemente:** o responsável da fase corrigiu o serviço enquanto a revisão estava em andamento. A fonte atual usa `clock_timestamp()` no banco, toma o SHARE lock e consulta novamente depois de adquiri-lo; repete a verificação após INSERT e após audit, antes do retorno da transação. A rejeição lança erro dentro de `withOrganizationTransaction`, cujo tratamento executa ROLLBACK. Foram lidas as regressões `after-lock` e `during-insert` em `apps/api/tests/unit/api-key-service.test.ts:73-89`, e executados novamente os três arquivos afetados: **48/48 testes aprovados**. O teste simulado exige rejeição e ausência de audit; o rollback físico continua sendo limite PostgreSQL não executado. O achado está fechado no código local revisado.

## Conformidade observada

| Fronteira | Resultado e limite |
| --- | --- |
| Contrato aditivo/versionado | Schemas estritos, `schemaVersion: 1`, IDs explícitos, SHA256/tamanho, atestação e objeto opaco limitado; injeção de tenant é rejeitada. O tenant usado vem do principal autenticado. |
| Scope explícito | `media:archive` adicionado ao enum/issuer sem promoção de chaves antigas. Rotas exigem API key com esse scope. Delegação exige scopes explícitos e revalida a emissora após lock, INSERT e audit; P1 fechado conforme acima. |
| Controle Chatwoot | HTTP rejeita scopes `chatwoot:*`; serviço e INSERT SQL rejeitam binding de controle mesmo se a linha da key receber archive indevidamente. O fence de controle passou a exigir seu enum próprio. |
| Autoridade dos recibos | Serviço toma organização/key e revalida a key atual com relógio do banco após locks e após INSERT. GET/evaluation também revalidam a key atual; não confiam apenas na autenticação inicial. |
| Associação/integridade | Join por organização/canal/mensagem/mídia real; apenas READY, SHA256 e tamanho exatos. Não escreve estado READY nem conteúdo/bytes da mídia. |
| Destino | Endpoint do tenant precisa estar ACTIVE e é bloqueado com SHARE na admissão. As APIs e grants atuais não alteram sua URL; v1 identifica esse vínculo. Recibo não certifica o storage físico atrás dele. |
| Idempotência | Serialização por tenant e UNIQUEs para header, recibo do cliente por endpoint e referência mensagem/mídia por endpoint. Corpo divergente ou nova intenção conflita. Replay autorizado entre chaves rotacionadas conserva identidade/acceptedAt. Replay depois da revogação do endpoint é recusado; GET conserva acesso à evidência histórica com key atual válida. |
| Múltiplas mensagens | Recibos específicos de mensagem; mesma mídia pode ter várias referências. FK composta com `media_id` protege contra troca posterior de anexo. A avaliação não generaliza um recibo para todas as referências. |
| RLS/permissões SQL | Migration prepara ENABLE/FORCE RLS por tenant, owner/policy de migrator, FKs compostas e RESTRICT, CHECKs, SELECT/INSERT para app e trigger de imutabilidade. Verificação estática; execução real pendente. |
| Lifecycle | Catálogo inclui recibos; patch exige reconhecer a função existente e remove metadados antes dos pais no purge explícito de canal. Trigger existente fecha INSERT durante exclusão. Não foi ensaiado purge real de canal/organização. |
| Retenção | KEEP é a única política, `eligibleForDeletion: false`, `physicalStorageVerified: false`. Não há GC, prazo presumido, DELETE de bytes, chamada ao storage ou promoção por ACK HTTP. O DELETE de metadados está restrito ao purge administrativo preexistente. |
| Fronteira documental | O item é fundação funcional de recibos e conservação. Relatório reconhece CCLX/storage/backup/restore/prazos/GC futuros e PostgreSQL não executado. Não representa retenção completa nem custódia física homologada. |

Não foram tratados como defeitos deste item os arquivos centrais de journal/runtime/schema/OpenAPI/policy que o responsável da fase declarou estar consolidando antes da entrega. B07, B05 e B13 ficaram fora do escopo desta revisão.

## Verificação executada

```text
npx vitest run apps/api/tests/unit/media-custody.test.ts apps/api/tests/http/media-custody.test.ts apps/api/tests/unit/media-custody-scope.test.ts apps/api/tests/unit/api-key-service.test.ts apps/api/tests/http/api-keys.test.ts apps/api/tests/unit/partner-media-contracts.test.ts apps/api/tests/unit/chatwoot-control-auth.test.ts --maxWorkers=1
```

Resultado independente: **7 arquivos / 70 testes passaram**, exit code 0, duração 18,80 s. A reprodução adicional acima confirmou um cenário vulnerável, não foi contada como teste aprovado da suíte. `git diff --check` dos arquivos tracked do diff B03: exit code 0, somente avisos de normalização CRLF/LF. Não foram executados build/typecheck/suíte geral pelo revisor; esses resultados são responsabilidade da consolidação e não são inferidos dos 70 testes.

Após a correção do P1, repetidos independentemente:

```text
npx vitest run apps/api/tests/unit/api-key-service.test.ts apps/api/tests/http/api-keys.test.ts apps/api/tests/unit/media-custody-scope.test.ts --maxWorkers=1 --silent
```

**3 arquivos / 48 testes passaram**, exit code 0, duração 12,81 s. São 46 casos anteriores repetidos e 2 regressões novas, totalizando **72 casos distintos verificados ao longo da revisão**; não se somam 70 + 48 como cobertura distinta. Os quatro arquivos não alterados pela correção conservaram sua execução inicial. `git diff --check` do serviço/arquivo de regressões após a correção: exit code 0.

## Limites e cobertura PostgreSQL

A suíte de integração preparada contém **7 testes**, incluindo concorrência/replay, rotação, RLS, FKs, várias mensagens, SQL direto, lifecycle de admissão e expiração enquanto aguarda lock de mensagem. Foi inspecionada e **NÃO EXECUTADA**. Seu guard exige URL explícita loopback, usuário/database `lab_` e declaração de cluster exclusivo; não consulta DBENV nem usa fallback. O fixture altera papéis globais e a flag é declaração operacional, não prova automática da exclusividade.

Permanecem sem prova real: aplicação/locks da UNIQUE adicional, RLS/grants/triggers/FKs, interleavings de revogação/expiração, ordenação de purge e compatibilidade da migration no cluster. A integração preparada testa a expiração pelo serviço de recibos; não cobre a emissora expirando ao delegar o scope (agora coberta por regressões offline), nem exercita expiração no INSERT SQL direto após espera ou execução completa do purge de canal/organização. Esses limites não foram convertidos em falhas fictícias de produção.

**Fechamento:** 70/70 testes offline iniciais e 48/48 na rechecagem após correção, 72 casos distintos; 7 testes PostgreSQL preparados e não executados. 1 P1 encontrado e fechado; **0 P0/P1/P2/P3 abertos**. Entrega revisada como fundação KEEP sem GC e sem homologação física; a integração PostgreSQL permanece pendente antes de afirmar validação real de banco.
