# Contratos e fronteiras de responsabilidade

Arquitetura preservada: consumidor/Chatwoot ⇄ Broker ⇄ Evolution privada. PostgreSQL conserva obrigações de entrega; Redis não substitui a outbox. O consumidor não recebe chaves da engine, DB ou Redis.

## Mudança efetiva: ACK negociado

`POST /v1/partner-webhooks` mantém o contrato existente e acrescenta `ackMode` opcional. Default **HTTP**: qualquer 2xx confirma transporte; 204 não exige corpo. **PERSISTENCE_RECEIPT_V1**: somente 2xx com JSON estrito, oito campos, IDs de evento/delivery/endpoint/organização correspondentes, UUID de recibo estável e timestamp UTC. Nenhuma rota nova foi inventada. A idempotência de criação compara URL normalizada e modo.

O modo estrito rejeita HTML, ausência de corpo, IDs divergentes, campos extras, conteúdo acima de 64 KiB e leitura que excede o deadline de 10 segundos. O HMAC e o envelope assinados mantêm o formato anterior. Os novos headers de correlação não constituem assinatura independente da resposta; a evidência depende de TLS/destino autorizado e do receptor cumprir o contrato.

O worker grava `DELIVERED` e recibo atomicamente, com lease vigente. Trigger impede recibo sem settlement válido e preserva sua imutabilidade; índice impede reutilizar recibo em outro delivery do mesmo endpoint. RLS e escopos existentes permanecem. `GET /v1/partner-webhook-deliveries` acrescenta `ackMode` e `persistenceReceipt` nullable, sem conteúdo da resposta remota.

O recibo comprova **aceite de declaração correlacionada**, não execução de negócio, entrega WhatsApp ou custódia física de mídia. A API de custódia continua contrato separado, com KEEP. Callback assíncrono de processamento não foi acrescentado neste incremento.

## Migration e compatibilidade

`0079_partner_persistence_receipts.sql`: coluna de modo em endpoints, três colunas de recibo em deliveries, constraint de completude, índice único, grants de colunas e trigger/função. Não cria tabela nem altera retenção. Endpoints existentes tornam-se HTTP, deliveries históricos continuam sem recibo. Readiness testa estrutura real, grants, predicados e corpo da função; divergência não recebe selo CURRENT.

Aplicada somente em bancos locais de teste. **A imagem API 0078 não é rollback compatível**, porque valida grants/manifesto exatos. Rollback de aplicação exige binário compatível com 0079 e preservação do ledger. Worker antigo não pode liquidar endpoint opt-in sem recibo. Revogar esse endpoint não torna readiness de API antiga compatível. Não há down migration proposta nem autorização de rollout neste incremento.

## Quatro fronteiras, quatro provas diferentes

| Fronteira | O que existe / mudou | Lacuna verificável |
|---|---|---|
| Chatwoot → Broker | Módulo Rails existente; autorização após HTTP agora verifica vínculo persistido atual | Janela `after_create_commit → WebhookListener → perform_later` ainda precisa obrigação durável e recuperação demonstrada |
| Evolution → Broker | Journal/overlay e recibo 0078 preservados; captura homologada em laboratório restrita ao recorte individual TEXT | Build/imagem final, bootstrap, ownership, tipos não cobertos e sessões reais não homologados |
| Broker interno | PostgreSQL, constraints, outboxes e leases existentes; 0079 acrescenta evidência de ACK | Concorrência/fairness/falhas sistêmicas completas ainda não são prova de capacidade |
| Broker → consumidor | Modo HTTP legado e novo modo estrito; receptor PostgreSQL/MinIO real em laboratório, retry após socket perdido | Rails/LAB2 completo, TLS e CCLX reais ainda pendentes |

`integration_jobs`, `partner_event_deliveries` e `messaging_outbox` são domínios distintos. Replay de evento parceiro não é novo envio WhatsApp. UNKNOWN não sofre reenvio cego. Retry atual permanece limitado a dez claims com backoff; jitter, Retry-After, circuit breaker e orçamento global ainda precisam incremento próprio.

## Identidades e CCLX

| Entidade / responsabilidade | Fonte e responsável | Aceite ainda necessário |
|---|---|---|
| Tenant/grupo/loja | RBAC/RLS Broker e contrato do parceiro | Definir cardinalidade de Accounts/lojas sem inferir tenant pelo telefone |
| Instância/canal/identidade aprovada | Broker e Evolution, mapeamento persistido | Reconexão com mesma identidade; número diferente não drena backlog anterior |
| Instalação/account/inbox/revisão | Módulo Chatwoot e vínculo Broker | Dois tenants, troca/revogação durante chamada e IDs semelhantes |
| Contato/conversa/protocolo | Consumidor; relatos CCLX apontam Cloud Function/Firestore | Contrato do fork, normalização/JID/LID e abertura de protocolo confirmados pelo CCLX |
| Pub/Sub/RabbitMQ/SkyWAN | Relato externo, não arquitetura comprovada | CCLX esclarecer função e tecnologia; não remover componentes por suposição |
| Histórico e mídia definitivos | Consumidor | PUT/GET privado, hash/tamanho e recibo; não presumir custódia de um POST de mensagem |

Nunca ativar simultaneamente dois transportes para a mesma inbox. Qualquer substituição do caminho legado requer plano por caixa, autorização específica e reconciliação. O teste JRC independente pode avançar sem acesso ao CCLX; somente detalhes do fork e o aceite em seu ambiente são DEPENDENTE_CCLX.
