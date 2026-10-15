# Fence dos respondedores nativos por Inbox

15/10/2026. Incremento aprovado pelo root depois do lote webhook/observer atual. Branch candidata dos dois repositórios; sem main, servidor, commit/push ou suites totais pelo implementador. Execução inline, sem novos agentes. O estado atual cobre os onze entrypoints JrcFlows e os hooks Playbook; não prova exclusão de AutomationRules/AgentBot.

## Autoridade de atribuição

O Broker já observa AgentBot ID/callback canônicos no preflight e persiste `flow_executor_cutovers.remote_bot_id/remote_bot_callback`. Transportar esse par pelo NativeOwnership request autenticado, construído em `cutover.ts::hostRequest`; não aceitar campos do browser. ID/callback devem ser ambos null ou ambos válidos. QR sem AgentBot exige null/null e recusa qualquer concorrente atual. CENTRAL exige o mesmo bot observado e persistido pelo Broker; o par nunca retargeta Account/Inbox/integration/channel ou o cutover.

O host exige o Bearer43 dedicado à registration: digest constante-tempo, registration.current, Inbox dentro do tuple e snapshot revalidado após introspecção. O segredo é gerado pelo host, enviado server-to-server na operação de challenge/register e não é retornado ao browser. Uma sessão Admin ou URL/ENV coincidente não concede essa audiência.

Persistir o par canônico no epoch sob o mesmo scope Account/Inbox/generation; a migration JRC20261015160000 fica reservada para isso e os triggers. Em fence/observe/retire/reopen, comparar o tuple/epoch e propriedades atuais de AgentBotInbox/AgentBot sob o lock do scope. Não tratar o antigo reopen-proof como atribuição de bot. Epochs anteriores sem essa evidência permanecem fechados/requerem reconciliação; não inferir um bot pelo texto da URL.

## Execução e transporte

- Envolver apenas ações perigosas de AutomationRules::ActionService: mensagem/attachment, webhook e controle do atendimento (atribuição/status). Reusar OwnershipGuard/OwnershipEffects. Regras mistas mantêm add_label/remove_label, leitura/CRM/SLA; outra Inbox continua operando. Não alterar ActionService global nem desabilitar NICO/AutomationRules.
- A prova dos 19 caminhos cobre somente Flow, mensagem/attachment, atribuição/status, webhook, AgentBot e os endpoints API legados implementados. As ações de e-mail/transcript mantêm o comportamento existente e ficam fora da prova de ownership; ela não afirma cobertura de toda AutomationRule.
- Registrar intenção Message por Message ID no ledger interno antes da entrega assíncrona. SendReplyJob consulta essa proveniência persistida; parâmetros de sender/automation_rule_id não concedem exceção. Manter branches NICO/ServiceDesk/Survey/Flow. Queued anterior ao fence pode ser cancelado; envio possivelmente ocorrido fica UNKNOWN e impede drain.
- AgentBotListener valida todos os eventos, não apenas mensagem. O job externo revalida bot/scope/recibo antes do HTTP; URL/payload de um job antigo são dados. Fixar a referência de entrega antes de enfileirar. Reusar o transporte/ledger existentes; um wrapper de job é permitido, outro engine não.
- Um bot já notificado pode responder depois pelo API. Usar AccessToken.owner/Current.user real nos endpoints mutantes de AgentBot (message/assignment/status); sender_type/id ou content_attributes não autenticam esse ator. A exceção Broker exige o par canônico vigente do epoch e a audiência/identidade efetiva, nunca uma whitelist de URL.
- HTTP ocorre fora de transações. Registrar claim antes, revalidar depois; timeout, revogação ou mudança durante I/O preservam UNKNOWN sem replay.

## Configuração e serialização

AgentBotInbox troca/ativação, AgentBot outgoing_url/secret/bot_type e Conversation.assignee_agent_bot_id precisam serializar contra o scope do fence. Incluir policy de greeting/autoassignment para que não seja reativada depois da aquisição. Um bot compartilhado não é desligado globalmente; as decisões são por Inbox. Usar triggers para cobrir caminhos alternativos/SQL, com locks de scopes em ordem determinística. Aquisição lê propriedades comprometidas sob o scope, sem precisar manter locks de linhas de bot durante rede. Mudanças redutoras precisam preservar a identidade/recibo corrente e não apagar prova incerta.

## Prova instalada e contrato

Os onze nomes antigos não expressam os executores novos. Acrescentar nomes reais de guard para regra, entrega, listener/job de bot, ator API e configuração no `FLOW_GUARDED_PATHS` do contrato de delegação existente e no host. Os caminhos precisam apontar aos hooks realmente instalados; não acrescentar strings sintéticas só para completar uma contagem. Heartbeat mede os ancestors adicionais e a instalação real dos triggers/funções no PostgreSQL. NativeOwnership recusa capabilities antes dessa verificação. Guard manifest, source/image aprovados e originCapabilityRevision existentes acompanham a nova versão; uma prova antiga11 não satisfaz o novo conjunto.

Não alterar automation-conversation/index/definitions do root. Não criar outro sistema de autorização ou recibos paralelos aos existentes. Não há DDL Broker planejado: as colunas canônicas já existem;0064 fica desnecessária se isso se confirmar.

## Arquivos e coordenação

Broker produto: `apps/api/src/modules/flows/delegation/native-ownership-contracts.ts`, `cutover.ts` (somente hostRequest/contexto), `native-adapter.ts` se necessário; contrato `packages/contracts/src/flow-delegation-constants.ts` para nomes reais. O schema em flow-delegation.ts já deriva a lista; mudar somente se o novo proof exigir. Testes focais em flow-native-ownership-adapter.test.ts, flow-service.test.ts e o teste de contrato de delegação pertinente. service.ts não deve mudar.

JRC: NativeOwnership/epoch +20261015160000, novos helpers/hooks de respondedores/entrega/configuração, initializer, AutomationRules::ActionService, AgentBotListener/WebhookJob, SendReplyJob, ponto de ator API, inventário de filas/contagens, guard/heartbeat e testes focais. Não editar os arquivos NICO, Command, JrcBroker::Client ou RecoveryJob NICO do root. BFF NativeEditor/Operation/Client/controller são do reviewer P3. Root promove o editor React compartilhado e gera assets; este incremento apenas inclui os hashes finais.

## Aceitação

RED/GREEN contra o schema/adaptador real e PostgreSQL: Inbox A FENCED bloqueia responder/atribuição, preserva labels e Inbox B; nova regra ativada depois não responde em A. Corridas de configuração/fence e retries anteriores são barradas no executor real. Recibo canônico Broker permite somente o bot vigente; null QR recusa concorrente, callback/ID falsos e registro/revisão revogados falham. Mensagem/job incerto conserva UNKNOWN e impede drain. HTTP fora da transação e revalidação após I/O são observados. A capacidade ampla só é anunciada depois de todos os hooks/triggers/provas existirem e a CI do SHA candidato passar.
