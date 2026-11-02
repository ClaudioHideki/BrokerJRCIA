# Broker JRC — implementação incremental sobre 977ab0e

**Parecer: incrementos locais implementados e revisáveis; Broker ainda parcialmente homologado. Não está 100% pronto para o piloto operacional nem para 400/900 sessões.**

O trabalho continuou o código existente, com reprodução, correção e regressão nas três frentes solicitadas. Não houve reset, reaplicação dos patches antigos, merge, push, imagem publicada, deploy, migration produtiva, mudança de credenciais, replay ou envio real. Backup, dump, restore e políticas não foram executados nem modificados.

## Estado reconciliado

Broker: branch `codex/broker-jrc-2-redesign-homologacao-20261030`, base local inicial `977ab0eed78ac3ad1aac75f38e6bba723eb86db2`, remoto `ClaudioHideki/BrokerJRCIA`. PR #6 permanece rascunho, empilhada sobre `codex/broker-audit-fixes-20261029` em `d1b66a56fe6d4f9202969784301abdf61490db45`. A main consultada estava em `be1e9441146d3ce8f9bc29b2f1b2fd135daf4371`. Não houve troca de base.

LAB2: checkout `release-grupojrc-20261022`, branch `codex/release-grupojrc-20261022`, base `abc1f7c57f55a7d9871101cd5b70c8b93becc7ca`, remoto correto `ClaudioHideki/jrc-conversas-lab2`. A default remota `codex/cadastro-mestre-20261002`, em `128243d925617c08896a2a9448b2bb9f6e5da115`, já é ancestral. A alteração preexistente em `.github/workflows/build-ghcr.yml` ficou intacta e não pertence a esta entrega.

O pacote histórico de publicação 977ab0e teve SHA256 reconferido. A implantação anterior de API/web e migration 0078 não foi repetida. A engine produtiva não foi considerada atualizada por causa da publicação API/web. A comparação do arquivo Compose entre main e candidata não mostrou diferença; isso não confirma o arquivo ou digests atualmente executados no Dokploy. O controle da aba continuou indisponível, portanto estado atual de servidor é **NÃO VERIFICADO / BLOQUEADO POR ACESSO**.

Os commits locais finais e a situação de cada checkout constam de `ENTREGA.json` no pacote. Nenhuma CI ou imagem histórica certifica o novo commit. A PR remota continua mostrando 977ab0e enquanto este incremento permanecer somente local.

## 1. Confiabilidade e ACK de persistência

Problema demonstrado: o worker genérico aceitava qualquer 2xx. Isso é correto para o contrato de transporte HTTP, mas insuficiente para declarar que o consumidor persistiu um evento. Os testes RED do contrato estrito e do receptor real falharam sem recibo.

Correção: modo opcional `PERSISTENCE_RECEIPT_V1` na criação do webhook. O padrão continua `HTTP`, preservando consumidores que respondem 204 sem corpo. No modo novo, exige-se JSON estrito com oito campos, correlacionando evento, delivery, endpoint e organização, além de UUID estável de recibo e timestamp. Limites de 64 KiB e deadline de 10 segundos impedem resposta ilimitada. IDs divergentes, HTML, ausência de corpo e recibo incompleto não liquidam a entrega.

O settlement grava status e evidência na mesma transação, com tenant e lease vigentes. A migration **0079_partner_persistence_receipts.sql** acrescenta o modo e três colunas de recibo, constraint, índice único e trigger de imutabilidade. Grants mantêm o modo imutável para a aplicação. Readiness verifica estrutura, índice, função e permissões reais. Não há tabela nova, redistribuição de outbox para Redis ou alteração de retenção.

Arquivos centrais: `apps/api/src/modules/partner-events/{ack-contract,service,worker}.ts`, `apps/api/src/http/routes/partner-webhooks.ts`, schema/readiness e migration 0079. Testes unitários, HTTP e PostgreSQL cobrem compatibilidade, corpo inválido, prazo, escopo, lease, reutilização de recibo e drift estrutural. OpenAPI, exemplos, coleção Postman e manual foram sincronizados com a mudança aditiva.

**Limite:** o recibo é uma declaração correlacionada do receptor. Não prova processamento de negócio, entrega WhatsApp, durabilidade física independente ou custódia de mídia. O ACK de origem 0078 continua outro contrato; este incremento não encerra B02.

**Compatibilidade de implantação:** a API antiga que exige schema/grants 0078 não é rollback compatível com 0079. Uma futura publicação precisa de binário compatível com 0079 e preservação do ledger; não excluir recibos nem aplicar down migration. Nenhuma migration foi aplicada fora do laboratório.

## 2. Mídias, perda de ACK e crash

O receptor `labs/cclx-postgres-simulator/worker-receiver.mjs` agora responde o recibo estrito depois do COMMIT e conserva a mesma identidade em retries. Registros legados sem a evidência negociada retornam conflito explícito. O worker real foi exercitado com PostgreSQL e MinIO privado, download/readback e perda da resposta após persistência.

Os dois cenários HTTP/estrito passaram: uma entrada e uma projeção lógicas, recibo estável e bytes conferidos. KEEP e `physicalStorageVerified=false` permanecem; não foi habilitado expurgo. Os arquivos são sintéticos, sem afirmação de criptografia por extensão ou de mídia WhatsApp física.

Dois testes adicionais com SIGKILL passaram sobre o Broker compilado atual e PostgreSQL real: crash antes do dispatch e após COMMIT antes do ACK. O processo voltou a entregar o mesmo evento sem duplicar a mensagem. Um caso usa a composição pinada de classes da engine. Isso valida a recuperação de processo no recorte do laboratório, não a imagem produtiva, autenticação Baileys ou reconexão de número real.

## 3. Integração com o LAB2 correto

Defeito reproduzido: durante uma operação remota de pareamento, o vínculo podia ser removido, substituído ou apontado para outra integração/instância, e a autorização ainda consultar o objeto antigo. A correção em `app/policies/jrc_broker_policy.rb` revalida o tuple persistido de id, Account, inbox, integração e instância antes de devolver o challenge. As leituras de autorização usam `uncached`; `manage?` em nível de Account conserva sua semântica.

Foram adicionados seis request specs em `spec/requests/api/v1/accounts/jrc_broker_spec.rb`, cobrindo administrador/agente e remoção/troca. O probe carrega as classes Ruby reais com arquivos e hashes identificados, rede desativada e portas de persistência simuladas. Resultado final: **20/20**. A sintaxe dos request specs foi validada; **o RSpec em Rails completo ainda não foi executado**.

O caso de cache modelado é defesa adicional, não exploração do query cache Rails comprovada: `Control.policy` já chama reload. A reprodução independente de vínculo removido/trocado continua válida. A janela entre commit da mensagem Rails e enqueue do webhook permanece um bloqueio interno separado; esta policy não resolve entrega que nunca chegou ao Broker.

## 4. Produto administrativo e empresa

`DeliveryDiagnostics` recebeu cards responsivos com os dez códigos conhecidos, quantidade, orientação e detalhes técnicos expansíveis. O horário exibido é o da consulta e o intervalo é o de criação das tarefas, sem inventar horário de incidente. UNKNOWN orienta conciliação, sem botão de reenvio cego. O diagnóstico explicita que cobre a empresa, inclusive vínculos desativados; não finge ser a saúde filtrada de um número.

`CompanyWorkspace` ganhou monitoramento por empresa usando a API real existente e os papéis/justificativa/auditoria de suporte. Sete abas foram preservadas. Carregamento, ausência, erro, falta de permissão e incerteza são estados distintos. A revisão independente corrigiu HISTORY_UNAVAILABLE: o produtor do erro é a importação na central, e a orientação mantém a mesma identificação da mensagem.

Quatro jornadas móveis anteriormente puladas passaram a ser executadas. O teste abre o menu por controle acessível, confirma URL/foco/fechamento e revoga especificamente a chave recém-criada. Não foram reduzidas assertions, adicionados `force` ou retries. E2E final: **41 passes e um skip exclusivo do shell mobile no projeto desktop**. Há API, PostgreSQL e Redis reais no laboratório, com provider sintético; parte da console é a rota legada, e não se declara homologação completa da nova jornada QR por isso.

**O redesign de todas as telas ainda não terminou.** A entrega cobre a jornada de diagnóstico e amplia a regressão das demais. A matriz registra 128 itens de tela/jornada em 82 arquivos, incluindo as 43 rotas registradas, aliases, abas e drawers. Ela não converte inventário em aprovação funcional.

## Cobertura e documentação

- `MATRIZ-APIS-WEBHOOKS.csv`: 356 operações reais, 24 colunas com método/rota, contratos, autorização, escopos, paginação, limites, referências e situação. Referência textual de teste não implica teste executado de cada operação.
- Quatro perfis públicos: 37 operações; manual PDF com oito páginas e exemplos. Demais operações internas/admin/embed/callback estão separadas. Coleções permanecem com escrita desativada por padrão.
- `MATRIZ-TELAS-JORNADAS.csv`: cobertura estática e lacunas de produto por jornada.
- `MATRIZ-REQUISITOS.csv`: 50 requisitos, status e aceite; namespaces AUD-Bxx e GO400-Bxx separados.
- `TESTES-E-EVIDENCIAS.md`: rodadas completas, falhas originais, retestes, exclusões e limites de prova.
- `CAPACIDADE-E-PILOTO.md`: estágios 50/100/200/400 e preparação para 900, reconciliação independente de IDs, critérios de parada e sessões físicas separadas de eventos.

Newman passou em ambos os modos: 19 requests/49 assertions por modo. Mídia teve seis guards e três requests válidos, sem envio ao provider. A regressão ampla teve 3.667 testes aprovados, duas expectativas obsoletas e quatro casos pulados por OpenSSL ausente; após corrigir as expectativas/PATH, os três arquivos passaram com 11/11. Não é correto divulgar a primeira rodada como integralmente verde, nem somar suites sobrepostas.

## Situação dos bloqueios e ordem de execução

| Prioridade | Item / situação | Próxima implementação ou prova verificável |
|---|---|---|
| P1 | AUD-B02 **PARCIAL** | Construir imagem final da engine pinada e atestar bootstrap/ownership; repetir crash/restart com os tipos cobertos; somente depois sessão controlada autorizada. Hoje a produção permanece UNPROVEN. |
| P1 | AUD-B03 **PARCIAL** | Fechar produtor real → Broker → storage LAB2 → recibo/readback por tipo de mídia, incluindo truncamento, expiração e indisponibilidade; KEEP até prova adequada. |
| P1 | LAB2 **PARCIAL** | Executar os seis request specs e jornada Rails/Sidekiq/TLS em duas Accounts; implementar obrigação durável na janela commit/enqueue antes de declarar bidirecional completo. |
| P1 | AUD-B05 **PARCIAL** | Canários de QR/auth/tokens na imagem efetiva da engine e no coletor. A redação em código não é teste de log produtivo. |
| P1 | AUD-B07 **PARCIAL** | Homologar reconexão, identidade e eventos/poll atrasados na engine final; geração antiga não deve drenar backlog novo. |
| P1 | AUD-B12 **PARCIAL** | Novo ACK comprovado localmente; continuar Retry-After/jitter/orçamento/circuit breaker conforme contrato. Reprocessamento de eventos parceiros não é replay de integration_jobs. |
| P1 | AUD-B13 **PARCIAL** | Medir pools somados de APIs/workers/engines/reserva, recursos e picos antes de elevar quotas. |
| P1 | AUD-B14 **PARCIAL** | Demonstrar fairness com tenant/destino lento e concorrência, preservando progresso dos demais. |
| P1 | Erros reais / UNKNOWN **BLOQUEADO POR ACESSO** | Coletar estado atual somente leitura, correlacionar revisões/status/IDs; não limpar contadores ou reenviar. |
| P2 | Produto completo **PARCIAL** | Fechar uma jornada por vez com backend real, estados/RBAC/acessibilidade e screenshots; seguir matriz, não apenas trocar o shell. |
| P1 | Piloto/capacidade **NÃO VERIFICADO** | Carga sintética independente com IDs, então 1–2 sessões autorizadas, lotes até 50/30 dias; 100/200/400 medidos antes de 900. |

As 436 FAILED, quatro UNKNOWN e 1.382 PENDING são apenas fotografia histórica. Nenhuma causa produtiva foi declarada a partir do nome de um erro. `DIAGNOSTICO-ERROS.md` separa causas comprovadas localmente de hipóteses e define a coleta por família.

Somente confirmação do fork, mapeamentos/protocolos e aceite no ambiente CCLX são **DEPENDENTE CCLX**. Engine, LAB2, mídias, código JRC, UI e testes de capacidade internos continuam responsabilidade JRC. A falta de acesso ao cliente não encerra esses itens.

## Segurança e limites finais

Revisão final não encontrou novo achado acionável após corrigir a orientação P2. Permanecem os limites explícitos: confiança no recibo do consumidor, falta de verificação física produtiva, janela de enqueue Rails, engine não homologada, servidor atual não consultado e capacidade não medida. Não há promessa de perda zero ou equivalência completa ao WhatsApp Web.

A exclusão de backup/restore neste incremento não constitui evidência de recuperação de desastre. Os mecanismos existentes foram preservados e não foram executados comandos agregados que os acionem.

O próximo passo de código mais verificável é a obrigação durável do lado LAB2 com reprodução de Broker indisponível após COMMIT, em stack isolada completa. Em paralelo pode avançar a próxima jornada de produto da matriz. Antes de qualquer publicação futura: revisão dos commits locais, CI do candidato sem rotinas excluídas, compatibilidade 0079 e autorização específica do rollout.
