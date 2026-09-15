# Enforcement SaaS por organização

## Contrato

Migração `0011_tenant_operational_limits.sql`: `organization_limits` contém `organization_id`, `max_instances` (5), `max_users` (10), `messages_per_day` (1000), `max_pending_messages` (1000), `updated_at`. Todos os limites são inteiros positivos. Instâncias Baileys e canais Meta compartilham a quota de conexões. Usuários contam memberships ACTIVE, incluindo proprietários. Reduzir um plano abaixo do uso atual preserva os registros e bloqueia novas admissões.

`organization_message_usage` contabiliza novas mensagens de saída aceitas por dia UTC. Uma admissão revertida não consome quota. A quota diária é de aceitação, não de entrega ou faturamento Meta; erros do provedor não devolvem automaticamente a reserva. Pendências incluem ACCEPTED, SENDING e UNKNOWN. Retentativas seguras voltam a verificar suspensão e capacidade de pendências sem contar uma nova mensagem diária.

Triggers bloqueiam a linha de limites e leem as contagens após a aquisição do bloqueio, serializando admissões concorrentes. Bloqueios compartilhados na organização ordenam admissão e suspensão. As tabelas novas têm FORCE RLS; `jrc_app` tem apenas leitura tenant dos limites/uso. Alterações administrativas usam política explícita de `jrc_platform`, sem BYPASSRLS. As funções de integridade não aceitam SQL livre e têm `search_path` fixo e EXECUTE público revogado.

## Suspensão e execução

Organizações SUSPENDED/DISABLED não criam mensagens, canais, instâncias, chaves ou pareamentos. A criação/conexão Baileys consulta o estado atual, inclusive nos caminhos de replay. Claims de envio e bot retornam vazios sem alterar pendências. A pré-validação de envio repete a consulta após o GET de templates e libera a lease ainda não enviada se houve suspensão. Ingestão de mensagens e recibos permanece permitida; conclusões de envios já em voo permanecem registráveis. A fronteira de início do envio é a pré-validação confirmada: uma suspensão posterior não desfaz a chamada externa.

Cada rodada existente percorre a allowlist de organizações, com no máximo um turno de bot e um envio por organização. Chamadas externas possuem prazos no cliente; não há drenagem ilimitada da fila de uma empresa. A retomada permite reivindicar pendências preservadas, sujeitas às políticas atuais de contato e janela Meta.

Erros HTTP usam códigos estáveis e não mensagens SQL: ORGANIZATION_NOT_ACTIVE (403), INSTANCE_LIMIT_REACHED, USER_LIMIT_REACHED, PENDING_MESSAGE_LIMIT_REACHED, DAILY_MESSAGE_LIMIT_REACHED (409). `readOperationalLimits` retorna estado, limites e `messagesAcceptedToday`, sempre em uma transação tenant.

O painel administrativo usa o mesmo mapeamento: exceder quota de usuários retorna 409 e nova admissão em organização suspensa retorna 403. A regressão HTTP reproduziu ambos como 500 antes da correção e verifica que detalhes internos do banco não são retornados.

## Isolamento auditado

- API keys: prefixo identifica a organização, HMAC valida segredo, consultas usam contexto tenant, cursores incluem organização; a autenticação relê o estado da organização e nega DISABLED imediatamente.
- Meta legado: cada entrada de META_CREDENTIALS_JSON exige `organizationIds`; referência conhecida de outra organização é negada. Typebot já exige a mesma allowlist. Segredos não aparecem no JSON do cliente nem em erros públicos.
- Conversas, sessões Typebot, mensagens e leases usam FKs compostas e predicates por organização. Não há cache global de sessões de conversa no broker.
- Baileys: chaves upstream derivam de UUID global único da instância; acesso passa pelo registro tenant e RLS. Desafios AES-GCM incluem organização, instância e operação como AAD. Arquivos de sessão do Evolution ficam na infraestrutura dedicada do provider; o broker não oferece acesso arbitrário a arquivos. Exclusão e restauração desses volumes dependem do runbook da infraestrutura.
- Administração de membership usa UPDATE para membro existente e INSERT apenas para admissão nova, preservando mudanças de papel/desativação no limite de usuários e durante suspensão.

## Evidências locais

TDD reproduziu ausência de quotas, pareamento durante suspensão, autenticação de chave de organização desativada e bypass de pendências por retentativa antes das correções.

- PostgreSQL: 29 testes passaram em tenant-operational-limits, messaging-storage, instance-isolation e api-keys; após novo caso de API key desativada, 7/7 desse arquivo passaram.
- PostgreSQL: após guarda de retentativa, tenant-operational-limits + messaging-storage passaram 21/21.
- Revisão final PostgreSQL: platform (6), tenant-operational-limits (7) e messaging-storage (15) passaram 28/28; idempotency passou 6/6 com plano explícito de 20 instâncias para o fixture compartilhado.
- Revogação Meta entre claim e pré-validação final foi reproduzida antes da correção; agora a referência `meta-db:` deve corresponder ao ID, organização, canal e ativos da conexão READY, com token presente e não expirado. Falha encerra a mensagem como FAILED e remove a lease.
- Unitários: instance-service, messaging-credentials e messaging-repository passaram 75/75; messaging-worker passou 2/2, incluindo alternância limitada de duas organizações.
- TypeScript API: `npx tsc -p apps/api/tsconfig.json --noEmit` passou.
- `git -c diff.ignoreSubmodules=all diff --check` passou (avisos de normalização CRLF/LF, sem erros de whitespace).

Somente banco local e doubles de providers foram usados. Nenhum envio real, deploy, commit ou push. As validações finais dos achados de revisão são registradas no relatório do controlador.
