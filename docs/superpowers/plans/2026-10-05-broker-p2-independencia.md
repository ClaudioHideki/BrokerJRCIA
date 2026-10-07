# P2 — Independência e isolamento: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans nesta sessão, sem delegação automática. A execução do programa e do P2 já foi autorizada pelo usuário.

**Goal:** Executar a mesma automação em atendimento local ou central autorizada, sem identidade externa fictícia nem conversão silenciosa de modo.
**Architecture:** Contrato discriminado de destino; catálogo local separado do remoto e autoridade revalidada na publicação, vínculo e execução. Entregas incrementais verificáveis preservam o executor e as operações duráveis existentes.
**Tech Stack:** TypeScript, Zod, Fastify, React, PostgreSQL, Vitest e Playwright.
**Spec:** ../specs/2026-10-05-broker-independente-centrais-design.md

## Restrições globais
- Um único executor de bot por caixa; central indisponível nunca vira standalone.
- RLS, organização e canal são obrigatórios; IDs externos não autorizam acesso.
- Nenhum HTTP dentro de transação; UNKNOWN não autoriza repetir efeitos externos.
- Sem distribuição automática nova; implantação e homologação externa permanecem separadas.
- Não criar IDs fictícios de Account/Inbox nem alterar versões publicadas.
- Release P1 preservada na main em 9bc0b7c (árvore igual ao candidato 0ba33a2). A correção do vínculo entrou em 1c6e49a; o audit foi corrigido por source-map-js 1.2.2 na main 4fe35badb475ff5d5ea69b3c91b198b5731a5f29. CI 37468304706 e imagens 37468365833 aprovados; digests em [registro de imagens](../../validation/2026-10-05-broker-main-images-and-binding.md). P2 permanece separado.

## Foco da revisão
1. Central desconectada após salvar transferência local: bloquear vínculo/execução — tarefa A.
2. Destino local de outra organização ou canal: rejeitar antes da escrita — A.
3. Humano assume entre reserva e aplicação: não declarar transferência do bot — A.
4. Queda do worker após aplicar transferência local: recibo transacional sem duplicar ciclo — A.
5. Troca de empresa com consulta pendente: descartar catálogo anterior — A/D.
6. Admissão de conexão central concorrente à validação local: serializar ambas no canal — A. RED observou conexão gravada antes da liberação; GREEN observou espera do lock, nenhuma conexão prematura, seguida de admissão após o commit local.

## A — Primeira jornada independente: fila local
Arquivos:
- Criar packages/contracts/src/attendance-destination-v2.ts.
- Criar apps/api/src/modules/attendance/{destination-adapter,local-catalog,local-handoff}.ts.
- Criar apps/api/src/http/routes/attendance-local.ts.
- Modificar automation-handoff-v1.ts, engine.ts, service.ts, handoff-{readiness,binding}.ts, automation-worker.ts, app.ts e openapi.ts.
- Criar apps/web/src/automations/node-editors/LocalHandoffEditor.tsx; modificar HandoffEditor.tsx e API de automações.
- Testar contratos, HTTP, editor e apps/api/tests/integration/standalone-handoff.test.ts.

Interfaces:
- LocalAttendanceScopeV2: kind LOCAL, organizationId UUID, channelId UUID.
- AutomationLocalHandoffConfigV2Schema: handoffVersion 2, destino local, target kind QUEUE.
- assertStandaloneDestination(tx,org,channel): canal existente/ativo sem conexão nem autoridade remota residual.
- createLocalAttendanceCatalog(options).listChannels(org): canais locais com scope e nome sanitizado.
- createLocalHandoffService(options).dispatch(item): recibo local e sessão WAITING_HUMAN atomicamente; identidade remota nula.
- Contrato remoto V1 preservado. Apenas fila manual local nesta entrega; agentes/times não são anunciados como disponíveis.

- [x] Escrever testes RED de contratos discriminados, isolamento, central FAILED/DISABLED, conflito humano, predecessor de mensagem não entregue e reentrada após recibo.
- [x] Rodar testes e comprovar falhas antes de implementar.
- [x] Implementar escopo, catálogo, publicação/vínculo e transferência transacional; reutilizar interrupção de bot e sessions.
- [x] Expor rota autenticada OWNER/ADMIN com no-store e papel atual; editor permite escolher explicitamente fila local.
- [x] Provar menu, captura, transferência, resposta humana e retomada com PostgreSQL e engine reais, transporte sintético identificado.
- [x] Rodar regressões, build/typecheck, npm test, contratos, OpenAPI e diff check; revisão independente sem bloqueios. Commit do incremento A após estes checks; evidências em [fila local](../../validation/2026-10-06-broker-p2-fila-local.md).

## B — Catálogo local completo e atribuição manual
Plano detalhado e registro: [times/agentes](2026-10-06-broker-p2-times-agentes.md), [evidências locais](../../validation/2026-10-06-broker-p2-times-agentes.md).
- [x] Modelar times/membros/fila e agente UUID separados de IDs Chatwoot numéricos; migration com RLS e lifecycle.
- [x] Validar usuários ativos e memberships atuais por função estreita; referência revogada impede publicação/atribuição.
- [x] Implementar destino time/agente e atribuição manual, sem algoritmo automático.
- [x] Testar membro revogado, empresa suspensa, fila sem atendente e takeover concorrente.

## C — Modos e onboarding observados
Incremento C1/C2: [plano](2026-10-06-broker-p2-modos-onboarding.md), [evidências locais](../../validation/2026-10-06-broker-p2-modos-onboarding.md). Consulta por caixa e orientação verificadas; transporte central e wizard público implementados em D2–D4 com evidência local. Instalação e homologação reais continuam pendentes.
- [x] Reutilizar onboarding, destination approval e compatibility existentes.
- [x] Expor STANDALONE/JRC_MANAGED/CHATWOOT_EXTERNAL com BROKER_TRANSPORT ou CENTRAL_TRANSPORT e readiness observada.
- [x] Wizard conta/credencial/caixa/bot/webhook/capacidades; não substituir webhook silenciosamente.
- [ ] Mesmo Account/Inbox em hosts diferentes e tenant A/B: catálogos, jobs, mídia e credenciais isolados.

## D — Transporte central e revogação
Plano detalhado: [transporte central](2026-10-06-broker-p2-transporte-central.md); [evidência incremental](../../validation/2026-10-06-broker-p2-transporte-central.md). D1–D4 implementados e verificados localmente: persistência, transporte exclusivo, cutover e recuperação guiada. Verificações CI/imagens e homologação externa são registradas separadamente.
- [x] CENTRAL_TRANSPORT alimenta runtime único; preservar origem, assinatura, deduplicação e BOT/HUMAN.
- [x] Cutover explícito remove executor legado por caixa, sem execução paralela.
- [x] Testar bot+integration webhook duplicado, replay, assinatura inválida, token revogado e troca de tenant com tela aberta.

## E — Homologação P2
- Configuração dos tenants JRC A/B e da instalação externa será feita ao final, conforme decisão do usuário em 06/10/2026. Preparação e ordem em [guia de homologação](../../validation/2026-10-06-broker-preparacao-homologacao.md); aprovação externa permanece pendente.
- [ ] JRC tenants A/B e Chatwoot externo reais; identificar versão/digests e IDs de correlação sanitizados.
- [ ] Revisão final e matriz de resultados: local/CI/externo, sem converter UNVERIFIED em SUPPORTED.
- [ ] P2 somente termina após B–E e a jornada externa; A é incremento funcional independente.
