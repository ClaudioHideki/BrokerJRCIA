# JRC WhatsApp Broker — fase 2, incremento 1

Data da execução: 2026-09-14

## Estado da entrega

Incremento local Meta/Typebot ampliado para operação SaaS multitenant, administração JRC e preparação Dokploy/GHCR. Recursos implementados e testes locais não equivalem a homologação externa. Não foi realizado App Review, envio real ou publicação.

## Base e escopo

Branch: codex/phase-2-console-meta-automations. Commit-base: 159ddfc18ed110957849e43e1825ef6c31ca3cd3. Console restaurada do ZIP fornecido e integrada à base Git. Evolution preservada no commit fixado; Ligo utilizada apenas como referência de produto. Arquivos restaurados não são apresentados como novos recursos escritos nesta fase.

## Funcionalidades

Meta texto/template e webhook assinado; inbox/outbox, idempotência, consentimento, Typebot e pausa humana. Contexto administrativo separado com senha/TOTP, empresas, responsáveis/usuários, planos/limites e suporte auditado. RLS e quotas no backend/worker. Embedded Signup, registro e verificação de pendências Meta; tokens criptografados. Portal, administração e infraestrutura de imagens/Compose documentados.

## Limites dos testes

PostgreSQL, Redis, autenticação, API e processamento são reais nos testes integrados. Meta, Typebot e conexão Baileys utilizam doubles. O E2E demonstra o percurso local e não comprova entrega externa, aprovação da Meta ou funcionamento de blocos de IA de um fluxo real.

## Validação observada

| Verificação | Resultado |
|---|---|
| npm ci / Docker npm ci | Lockfile instalado; Node local 24.16.0 e imagens verificadas com Node 24.19.0. |
| npm test | 826/826 testes passaram, 103 arquivos; inclui HTTP, UI e reprodutibilidade dos artefatos. |
| npm run test:integration | 151/151 testes passaram, 23 arquivos; PostgreSQL 16.4 e Redis 7.4 reais, duas ou mais organizações. |
| npm run build / npm run typecheck | Compilação API/web e TypeScript strict passaram. |
| vitest --config vitest.compiled.config.ts | 2/2 passaram; servidor compilado com PostgreSQL e Redis reais. |
| playwright test | 9 passaram; 5 exclusões esperadas de seleção de projeto mobile já existentes. Administração e mensageria passam em desktop e mobile; acessibilidade sem violações automáticas. |
| openapi:generate / security:contracts | Contrato atualizado, inventário de rotas explícito e fronteira pública aprovados. |
| test:web:bundle / security:notices | 3 arquivos do bundle sem achados; avisos de 7 pacotes de navegador aprovados. |
| npm audit | 0 vulnerabilidades reportadas em 14/09/2026; Vitest 4.1.11. |
| security:submodule | Passou; Evolution e submódulo interno preservados nos commits fixados. |
| docker build runtime / web | Duas imagens locais construídas, sem publicação: jrc-whatsapp-broker:saas-local e jrc-whatsapp-broker-web:saas-local. |
| test:container / smoke web | API saudável; frontend / e /jrc retornam 200; UID 1000. Containers temporários de smoke removidos. |
| docker compose config --quiet | Compose Dokploy validado com valores sintéticos; nenhum serviço de produção iniciado. |
| Revisão independente | Quatro achados corrigidos e reavaliados como atendidos: revogação Meta, troca de empresa, atualização no limite e rota raiz. |
| git diff --check | Passou. Branch codex/phase-2-console-meta-automations, HEAD 159ddfc preservado. |

## Correções de revisão

Corrigidos isolamento das credenciais Typebot, membership atual e RBAC, SQL e FK por canal, preservação do consentimento, ordem das respostas, lote de leases e falha determinada versus UNKNOWN. Pausa humana cancela automações ainda não iniciadas; preflight rejeitado finaliza claims corretamente; advisory locks serializam status e vínculo do ID Meta. Descadastro após enqueue/claim também impede texto automático. Vitest atualizado para 4.1.11 por GHSA-82fw-gwwq-j7x9, sem reduzir asserções.

## Revisão SaaS

Revisão independente identificou atualização de usuário no limite do plano, dados de interface após troca de tenant, revogação Meta durante preparação de envio e rota raiz do servidor web. As correções e regressões correspondentes estão incluídas na validação final. Ações externas já em voo não são desfeitas por uma suspensão posterior.

## Pendências funcionais

Coexistence, importação CSV/listas, gestão visual completa de consentimento, campanhas/agendamento/cancelamento, criação/aprovação de templates, mídia, webhooks JRC de saída e reconciliação visual UNKNOWN permanecem fora do incremento. O editor Typebot continua externo. Não existe upload de arquivos de clientes neste incremento.

## Pendências externas e operação

Configurar aplicativo JRC, Embedded Signup, permissões/aprovação Meta, ativos autorizados, pagamento e domínio HTTPS. Homologar o fluxo real e a versão Graph escolhida; os testes usam doubles. Preparar credenciais do registry, ambiente protegido de publicação e segredos Dokploy. Backup/restauração/retenção/exclusão têm runbook; rotinas agendadas e RPO/RTO dependem do servidor e de ensaio operacional.

## Licenciamento

Conector Typebot por API com edição externa. Não foi incorporado o editor. Avaliar separadamente versão específica convertida para Apache 2.0, editor/runtime próprios ou autorização comercial. A licença atual consultada é FSL-1.1-Apache-2.0; iframe não altera os requisitos de licença.

## Acesso e reprodução

Guias: docs/operations/dokploy-saas.md, saas-admin.md, saas-enforcement.md, saas-meta.md e meta-typebot.md. Desenvolvimento: http://127.0.0.1:5173/jrc (equipe) e /login (cliente); no Dokploy, domínio aponta ao web:8080. Os testes não deixam servidor permanente. Recriar relatório: python scripts/security/render-phase2-report.py. validation.json contém resultados observados, não novos testes executados pelo gerador.

## Limites de autorização

Nenhum commit, push, PR, merge, deploy, mensagem real ou alteração em produção foi realizado. Artefatos históricos preservados. Esta revisão cobre o incremento descrito e não afirma ausência geral de vulnerabilidades.

## Evidências de código

- Administração dedicada, MFA e suporte auditado: apps/api/src/modules/platform/service.ts:11
- Limites e admissão transacional por empresa: apps/api/drizzle/migrations/0011_tenant_operational_limits.sql:1
- Autorização Meta do aplicativo JRC: apps/api/src/modules/meta-onboarding/service.ts:17
- Interface administrativa separada do portal: apps/web/src/pages/Platform.tsx:12
- Serviços Docker e fronteiras de credenciais: infra/dokploy/compose.yaml:29
- Transporte Meta limitado e sem retry cego: packages/providers/src/meta/cloud-client.ts:293
- Assinatura dos bytes originais: packages/providers/src/meta/webhook.ts:56
- Conector Typebot com validação de destino: packages/providers/src/typebot/client.ts:52
- Credenciais Typebot limitadas por organização: apps/api/src/modules/messaging/credentials.ts:37
- Claim durável e política de envio: apps/api/src/modules/messaging/repository.ts:878
- Sessão e respostas atômicas: apps/api/src/modules/messaging/repository.ts:1340
- RBAC e rotas JRC: apps/api/src/http/routes/messaging.ts:45
- Membership atual, usuário e organização ativos: apps/api/src/modules/messaging/membership.ts:5
- Execução fora da transação: apps/api/src/modules/messaging/worker.ts:15
- Persistência, chaves compostas e RLS: apps/api/drizzle/migrations/0009_messaging_storage.sql:13
- Percurso de navegador com doubles: apps/web/tests/e2e/messaging.spec.ts:5
