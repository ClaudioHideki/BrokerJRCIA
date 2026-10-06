# Broker — capacidade, armazenamento e operação multitenant

> **For agentic workers:** Use superpowers:executing-plans inline e superpowers:test-driven-development para implementar as tarefas, sem delegar implementação. Reutilizar o checkout main; entregar incrementos validados na main.

**Goal:** Preparar e medir a infraestrutura para 500 empresas, até 10.000 conexões e empresas com 250.000 conversas/mês, entregando jornadas funcionais no servidor.

**Architecture:** Reutilizar runtime, workers, leases e inbox/outbox do Broker. Distribuir transporte QR e trabalho sem duplicar execução; separar estado transacional, mídia privada e cache. A implantação concreta depende do inventário do servidor e dos resultados de carga, sem impor um número arbitrário de máquinas.

**Tech Stack:** Stack vigente do Broker, PostgreSQL, Redis, motores Evolution, armazenamento compatível com S3 e Dokploy. Selecionar biblioteca S3 e ferramenta de carga após verificar versões/licenças e compatibilidade; nenhuma dependência é instalada por este plano.

**Spec:** ../specs/2026-10-05-broker-independente-centrais-design.md, ampliação de 06/10. Complementa P0/P4/P8/P9/P10; não substitui P2 D2–D5.

## Baseline de infraestrutura conhecido

O usuário informa infraestrutura própria modular em datacenter Tier 3 e possibilidade de provisionar PostgreSQL, Redis e MinIO; Broker e JRC Conversas estão nesse ambiente. Não foram informados CPU/RAM/disco/rede/alta disponibilidade efetivos. Tier do datacenter não determina capacidade da aplicação. O servidor de Chatwoot externo pertence ao cliente; integração deve operar pela API autorizada, sem presumir acesso à infraestrutura dele.

No Compose versionado, Evolution é serviço separado da mesma stack, acessado internamente por http://evolution:8080. Usa banco jrc_evolution no serviço PostgreSQL, Redis DB 6/prefixo jrc-evolution e volume engine_instances. Limites configurados desse container: 2 CPUs/2 GiB; não são uma medição de uso nem capacidade de 10.000 conexões. Confirmar o Preview Compose e o container efetivo no Dokploy antes de tratar esse arquivo como inventário instalado. Evolution grava mensagens/contatos/chats/histórico conforme as flags atuais; esse armazenamento adicional também entra no orçamento e na retenção.

O adaptador do Broker provisiona via POST instance/create usando upstreamInstanceKey interno e integration WHATSAPP-BAILEYS. Cada instância de WhatsApp é uma sessão gerenciada pelo motor, não um container novo. A passagem para vários motores exige registry/roteamento por instância e teste de preservação da identidade; mudar somente EVOLUTION_BASE_URL não é uma distribuição de carga segura.

## Restrições e critérios

- Um executor e um transporte autoritativo por caixa; ordenação por conversa e isolamento tenant em todos os estados, leases e objetos.
- Operação READY deve permitir o percurso completo. Pré-requisitos ausentes têm diagnóstico e procedimento de correção; não entregar funcionalidade permanentemente pausada sem caminho de ativação.
- WhatsApp, Meta, Chatwoot e JRC reais são homologados no servidor com caixas de teste; provedores simulados só comprovam o escopo explicitamente simulado.
- UNKNOWN remoto é reconciliado, sem repetição cega. QR revogado exige nova autenticação; reconexão automática cobre falhas recuperáveis.
- Não gerar carga contra clientes reais. Ambiente de carga separado e dados sintéticos; piloto produtivo na caixa Welton já autorizada.
- Não gravar payloads de clientes, números, tokens ou sessão Baileys em evidências/telemetria.

## C0 — inventário e modelo de carga

**Files:** scripts/operations/capacity-report.mjs; docs/validation/broker-capacity-baseline.md; tests/capacity-report.test.mjs.

**Interfaces:** relatório somente leitura, com versão/digest, CPU/RAM/disco/rede, serviços/réplicas, limites e contagens agregadas. Sem listar ambiente completo ou credenciais. Inventário Dokploy pelo usuário quando não houver acesso ao host.

- [ ] Registrar recursos do servidor, uso/picos, latência de disco, topologia, versões, replicas, limites dos pools, persistência Redis, volumes QR e provedor/bucket S3.
- [ ] Registrar distribuição de empresas/conexões, simultaneidade, mensagens por conversa, mídia, retenção, pico e duração da rajada. Separar os perfis QR, Meta e central nativa.
- [ ] Testar sanitização, permissões insuficientes e resultado parcial explícito; coletar baseline sem alterar serviços.
- [ ] Criar matriz de carga com metas de latência, backlog, recuperação, RPO/RTO definidas a partir desse baseline e da jornada desejada; não anunciar metas como já atingidas.

Modelo: mensagens/s = conversas/mês × mensagens/conversa ÷ segundos do período; pico é medido separadamente. Uma empresa com 250.000 conversas em 30 dias representa média de aproximadamente 0,096 conversa/s. Se todas as 500 tivessem esse volume, seriam 125 milhões de conversas/mês, cenário que não foi informado como carga real. Multiplicar também efeitos por nó, webhooks, leitura canônica, anexos e espelhamento ao estimar trabalho/armazenamento. 10.000 conexões WhatsApp não requerem 10.000 sessões SQL.

## C1 — distribuição de trabalho, pools e telemetria

**Files:** apps/api/src/commands/messaging-worker.ts; automation-worker.ts; automation-io-worker.ts; scheduler-worker.ts; apps/api/src/db/pools.ts; infra/dokploy/compose.yaml; scripts/operations/load-broker.mjs; apps/api/tests/integration/worker-capacity.test.ts.

**Interfaces:** assignment de trabalho inclui org/canal/conversa e lease atual; métricas agregadas por componente e perfil, sem labels de telefone/conversa. Pools têm orçamento total incluindo APIs, workers, autenticação, lifecycle, migração e conexões reservadas. Aumentar replicas não aumenta max_connections sem medição.

- [ ] RED: tenant com backlog não bloqueia outro, reentrega/restart não duplica efeito, conversa preserva ordem, réplicas disputam lease com segurança e polling lento não oculta saúde.
- [ ] Medir o scan sequencial existente por empresa, shard atual de mensageria e trabalho por rodada. Implementar concorrência limitada/distribuição quando o teste apontar gargalo; nenhuma troca automática de shard no meio de envio.
- [ ] Instrumentar duração de fila/nó/IO, throughput, idade do backlog, leases/UNKNOWN, lag de callback, espera de pool, uso de disco/RAM e reconexões. Definir limites por empresa e fila de erro com recuperação operacional.
- [ ] Validar sob carga distribuída, tenant concentrado, restart e dependência lenta. Registrar configuração e resultado exatos antes de aplicar ao servidor.

## C2 — mídia privada em S3 e recuperação

**Files:** apps/api/src/modules/messaging/media-store.ts; apps/api/src/modules/messaging/object-storage.ts; migração versionada após o baseline vigente; scripts/operations/backup.mjs; restore-drill.mjs; infra/dokploy/compose.yaml; tests/integration próprios.

**Interfaces:** ObjectStorage.put/read/delete recebe identidade interna org/channel/mediaId e bytes cifrados; chave de objeto gerada pelo servidor, sem caminho fornecido pelo usuário. Banco persiste backend, chave, tamanho, hash, versão e estado. READY somente após objeto confirmado e metadata comprometida. Download continua autenticado; URLs públicas não substituem autorização.

- [ ] RED: acesso cruzado entre tenants, hash inválido, falha S3 antes/depois do upload, lease perdida, replay, remoção concorrente, limite/retention e restart entre objeto e commit.
- [ ] Implementar adaptador e migração compatível com mídias antigas no banco. Reconciliar objetos órfãos e upload incerto sem apagar objeto ativo nem fingir READY.
- [ ] Provar leitura e entrega pelos dois sentidos QR/Meta/central, sem expor credencial S3 ao navegador. Testar consumo de RAM com anexos e downloads concorrentes.
- [ ] Restaurar metadados/chaves/objetos de janela compatível; testar retenção, versionamento e backup externo. Redis, banco e sessões QR fazem parte da recuperação; cache não é prova de mensagem entregue.

## C3 — motores QR, reconexão e credenciais Meta

**Files:** packages/providers/src; apps/api/src/modules/instances; registry de provider/motor e migração versionada; infra/dokploy/compose.yaml; testes de conexão/restart e smoke por versão.

**Interfaces:** canal estável aponta para engine autorizado e geração de sessão atual; engine URL/credencial não vêm do payload. Lease exclusiva de conexão e comando idempotente. Reconectar não recria canal ou contato nem muda Account/Inbox.

- [ ] RED: engine cai, callback antigo chega após reconexão, restart preserva sessão, sessão revogada exige QR, duas replicas tentam reconectar, QR/pairing expira e destino da central permanece igual.
- [ ] Medir memória/CPU por sessão QR ativa/ociosa e por eventos. Distribuir instâncias entre motores com roteamento persistido e transferência explícita; não presumir capacidade de um único Evolution para 10.000 sessões.
- [ ] Implementar backoff/jitter e controle de tempestade de reconexão, recuperação e diagnóstico. Nunca fazer envio duplicado durante migração de engine.
- [ ] Homologar QR real no Welton e Meta real após onboarding/parceria/ativos configurados. Credencial/token revogado tem correção concreta, sem fallback Meta→QR ou central→standalone.

## C4 — carga, implantação e jornada do cliente

**Files:** scripts/operations/load-broker.mjs; docs/validation/broker-capacity-results.md; docs/operations/broker-capacity-runbook.md; cenários E2E Broker e interfaces centrais.

- [ ] Provar 500 identidades tenant/10.000 canais lógicos sintéticos, separando essa prova da quantidade de sessões WhatsApp reais simultâneas.
- [ ] Testar carga sustentada/pico e mistura de mídias conforme C0, bursts/reentrega, tenant concentrado, indisponibilidade e recuperação de filas. Exigir contagens reconciliadas e ausência de vazamento/efeito duplicado conhecido; UNKNOWN fica identificado.
- [ ] Medir motores com sessões reais autorizadas em lote progressivo; registrar limite efetivamente observado e margem, sem extrapolar teste lógico para sessões reais.
- [ ] Gerar API/web do mesmo SHA da main após CI aprovado; orientar migração/ativação no Dokploy e conferir digests/flags/schema/backup. Atualização é feita pelo usuário.
- [ ] No servidor: conectar → caixa → canvas/Flow → publicar → vincular → menu → captura/opção → time/agente/etiqueta → resposta humana → pausa → retomada. Repetir pelo módulo Flow/QR da central e nos três perfis JRC A/B/Chatwoot externo configurados ao final.
- [ ] Registrar versão, configuração, correlações sanitizadas, tempo e resultado real por etapa; corrigir falhas antes de encerrar o perfil. Não declarar 100% ou 10.000 sessões homologadas com testes locais.

Referências de infraestrutura: [PostgreSQL 16: conexões](https://www.postgresql.org/docs/16/runtime-config-connection.html), [Redis: persistência](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/), [S3: armazenamento de objetos](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html), [APIs Chatwoot](https://developers.chatwoot.com/api-reference/introduction). Referência de protocolo não prova capacidade instalada.
