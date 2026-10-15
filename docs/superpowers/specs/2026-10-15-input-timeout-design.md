# Captura com prazo persistido — contrato 1

Desenho aprovado em 15/10/2026 para o candidato de homologação. Implementação sobre o lote Broker `4c7a5eff1a3fa427aa52ef57636b9e00c7ad7fd8`, com migration 0061; a 0062 pertence à tomada NICO coordenada. Não envolve produção ou ações remotas de conversa.

## Comportamento público

Novos blocos input declaram `inputConfigVersion: 1`. `variable` é uma chave segura, `text` é opcional e `timeoutSeconds` é opcional, inteiro de 1 a 604800. Strings, frações e null não são convertidos em duração. Com prazo, `next` e `timeout` devem estar conectadas; sem prazo, permanece somente `next`. O timeout segue sua saída sem preencher a variável nem substituir a última mensagem do cliente.

Ausência do marcador preserva o contrato histórico, inclusive portas e metadados importados. `timeoutSeconds` histórico isolado não ativa relógio. Um `timeout` importado positivo continua exigindo reparo explícito. Marcador desconhecido é inválido. O editor permite converter explicitamente a captura, escolher prazo e conservar o draft inválido para correção.

Reinício de processo e retry comum conservam o prazo absoluto da tentativa. A retomada humana **CONTINUE**, somente depois de confirmada pelo serviço de atendimento existente, inicia outra tentativa da captura com waitId novo e prazo integral configurado. O ciclo anterior não transfere mensagens pendentes nem autoridade sobre a nova espera. Menu e captura legados mantêm sua continuação anterior.

## Estado e entrada interna

`RuntimeState.waiting` continua `EVENT`, acrescentando `waitId` e `deadlineAt` opcional em epoch milliseconds. O UUID identifica uma tentativa, inclusive reentrada no mesmo nodeId e espera em filha. `RuntimeResult.wait` leva o mesmo UUID e deadline como Date. A PK tenant de `automation_waits` é essa identidade, sem tabela adicional.

`RuntimeInput.inputWait?: { waitId: string; admittedAt?: number }` é interno. Repository e router o constroem a partir da espera bloqueada e da admissão SQL; o simulador o constrói do seu relógio virtual. O campo nunca é aceito de payload comercial. MESSAGE exige identidade correta e admissão finita; TIMER exige identidade correta e relógio no prazo ou depois. Timer antigo, envelope ausente/forjado e RESUME não encerram a captura. A retomada manual genérica é rejeitada antes de consumir uma captura marcada.

## Admissão e decisão única

`automation_events.created_at` usa o início da transação e pode anteceder a obtenção do lock. Por isso 0061 adiciona `admitted_at`, escrito com `clock_timestamp()` ao associar a mensagem à execução, já sob seu lock. Backfill usa created_at apenas para filas históricas já associadas. Timestamp externo não participa da decisão.

O caminho mantém o prefixo de autoridade do canal e a ordem **execution → wait → evento**. `promoteAttendanceInput` é compartilhado pelo ingresso, persistência de nova espera e scheduler:

1. Bloquear a espera atual e conferir UUID, nodeId e deadline contra o estado persistido.
2. Revalidar autoridade humana, tenant, vínculo e versão; a política física de grupos é repassada explicitamente, com default restritivo preservado.
3. Selecionar a primeira MESSAGE pendente elegível por queue_sequence. Admissão **até inclusive** deadline vence, mesmo se o worker executar depois.
4. Sem mensagem elegível e com prazo vencido, inserir evento `INPUT_TIMEOUT` consumido com chave `input-timeout:<waitId>`, marcar a espera RESUMED e enfileirar o TIMER interno na mesma transação. CAS e locks impedem dois vencedores.

Mensagem bloqueada antes do execution lock ainda não foi admitida. Mensagem admitida depois do prazo não preenche a captura expirada; continua no backlog da execução. O fluxo existente determina o destino posterior desse backlog. A fila não recebe ACK de efeito remoto fictício.

## Migration, scheduler e segurança

0061 adiciona `automation_events.admitted_at` e `automation_waits.deadline_at`, constraint que admite deadline somente em EVENT e índice parcial de esperas EVENT vencíveis. DELAY conserva wake_at; IO conserva sua própria retomada. RLS, grants e chaves tenant existentes permanecem. O probe de readiness exige as duas colunas, constraint validada e índice válido; baseline cumulativo acompanha a 0062 coordenada.

`releaseDueWaits(tx, org, limit)` e sua facade continuam as interfaces do scheduler existente. A descoberta inclui EVENT com deadline, bloqueia canais em ordem e pula execuções ocupadas com SKIP LOCKED. O bootstrap repassa a mesma GroupPhysicalPolicy/fleet scope já usada pelos runtimes, sem iniciar outro loop ou fazer HTTP; ausência da configuração conserva a negação. Isso não amplia o catálogo de grupos: input permanece GROUP_NODE_UNSUPPORTED. Não há worker, endpoint público de TIMER ou novo serviço. Cancelamento e tomada humana impedem requeue; revalidação preserva bloqueios NICO/UNKNOWN existentes. A mudança não reconcilia efeitos desconhecidos.

CONTINUE confirmado lê o input da versão publicada fixada e calcula o novo prazo com relógio do servidor dentro da transação. Subflows conservam a versão filha/pilha e seu timeout geral separado. Retomada humana continua restrita ao cursor raiz compatível pelo contrato existente.

## Simulação e interface

MESSAGE e ELAPSE continuam sendo os únicos eventos públicos necessários. O simulador atravessa deadlines EVENT e wakeAt DELAY pelo motor canônico. Studio oferece o mesmo controle de avanço virtual para captura com prazo. O diálogo de retomada explica o reinício da tentativa após confirmação; não sugere que publicar ou vincular fluxo retoma atendimento humano.

## Validação

Regressões de contrato, motor, reentrada, filha/restart, legado, editor, Studio e simulação observadas em RED antes da implementação; lote focal de 178 casos verde. PostgreSQL real como jrc_app exercita identidade/prazo, admissão do servidor, empate, restart/dedup, corrida entre MESSAGE e dois schedulers, cancelamento, HUMAN e RLS entre tenants. Revisão acrescentou regressões de RESUME genérico, política de grupos e CONTINUE humano. Os comandos e resultados finais ficam no [plano de implementação](../plans/2026-10-15-input-timeout.md). Suíte integral e integração Git pertencem ao coordenador.
