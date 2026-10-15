# Lease para observação e bind JRC_NATIVE

Data: 15/10/2026. Design aprovado pelo responsável da integração em `codex/nico-broker-coordenado-20261015`. Escopo: cutover, recibo interno no bind e testes focais; sem migrations nem contratos HTTP novos.

## Problema

Prepare/reconcile conclui em DRAINED e limpa a lease. O bind enviava essa linha a observeFence, mas o schema real NativeOwnershipRequestSchema exige token UUID e prazo. O helper anterior aceitava null==null e ocultava a falha. Uma observação nova precisa de uma tentativa identificável, persistida antes do HTTP e revalidada antes de alterar o proprietário.

## Solução

O tipo interno NativeBindReceipt contém organização, integração, cutover, revisão do cutover, expectedOwnerRevision, leaseToken e leaseExpiresAt. O recibo é criado no servidor e passado explicitamente entre beforeTransaction, verify e activate; nenhuma referência de objeto concede autoridade e nenhum novo campo HTTP é exposto.

1. Uma transação curta verifica authority/profile/origin/owner e a prova DRAINED ainda válida. Para JRC_NATIVE, recusa uma lease concorrente viva e reserva um token novo, por até dez segundos e nunca além de proof_valid_until, usando clock_timestamp().
2. Após o commit, executa os probes existentes e observeFence com o request estrito. Não repete fenceAndDrain.
3. Após o I/O, obtém nova decisão de autoridade fora da transação e revalida contexto, revisão, proprietário, token persistido e prazo SQL em outra transação curta.
4. O scoped de service.ts mantém o recibo tipado durante toda a operação bind. AutomationService.bind usa uma transação de leitura e outra de mutação; CENTRAL usa leituras adicionais. Essas transações reutilizam a mesma evidência e revalidam pelo banco.
5. Activate verifica o recibo e consome a lease no mesmo UPDATE que grava ACTIVATED, binding e activated_owner_revision. A lease persistida e o prazo do próprio recibo devem continuar vivos no SQL.

STOCK retorna recibo null, conserva suas observações por transação e não adquire requisito de registro/lease nativa. Os guards, fences, tombstones e caminhos de reconciliação existentes permanecem.

## Cleanup, concorrência e restart

O finally do método externo service.bind chama releaseBinding depois de toda a operação. Uma falha após a reserva move somente DRAINED com a mesma organização, integração, cutover, revisão e token para UNKNOWN e limpa a lease. Essa redução continua permitida depois de revogação da autoridade. Cleanup falho é reportado; não se declara sucesso sobre erro de banco.

| Situação | Resultado |
|---|---|
| A possui lease viva | B falha antes do observe e não limpa A |
| A expira, B reserva token novo, A retorna tarde | A não ativa nem limpa B; B pode concluir após suas próprias verificações |
| Expiração ou revogação no I/O | Nenhuma binding; tentativa própria vira UNKNOWN |
| Timeout e resposta tardia | UNKNOWN continua, sem ativação tardia |
| Falha entre recibo e transação final | Rollback da mutação e cleanup condicional da tentativa |
| ACTIVATED | Token consumido; cleanup é no-op |
| UNKNOWN preexistente | Bind recusa; reconciliação explícita continua necessária |
| Processo/conexão interrompido depois da reserva | Fence continua fechado; lease expira no banco. Nova operação precisa de outra observação e nova revalidação |

## Validação e limite da evidência

O teste de regressão usa createNativeFlowAdapter e NativeOwnershipRequestSchema reais, credencial/sessão nativas reais e PostgreSQL descartável. O fetch sintético consulta a lease persistida durante HTTP e exige token, prazo e lease SQL viva. Uma conexão independente obtém FOR UPDATE NOWAIT no cutover; AsyncLocalStorage verifica que chamadas de introspecção, ownership e probes Chatwoot não estão no contexto de uma transação.

O Windows e o PostgreSQL Linux local apresentaram diferença de poucos milissegundos. Como checkedAt é capturado antes do adapter e o transporte fake seria instantâneo, apenas o retorno sintético da introspecção aguarda o instante de entrada no relógio SQL, por consultas clock_timestamp(), com limite de um segundo. Não há sleep arbitrário, mock global de relógio ou alteração da regra produtiva. Leases, expirações, barreiras e disputas continuam usando SQL real.

RED observado: o bind positivo falhava em FLOW_HOST_FENCE_REQUIRED antes de observe devido à lease nula. GREEN: oito casos novos passaram em 27.88s, com 49 casos antigos fora da seleção. Logs locais estão em `.superpowers/sdd/2026-10-15-nico-broker-estabilizacao/native-bind-work/` (`red.log` e `fourth-green.log`).

Isso valida Broker, adapter e persistência contra host simulado estrito. Não atesta módulo instalado, imagem executando no host nem funcionamento produtivo. A suíte final integrada é coordenada pela tarefa principal.
