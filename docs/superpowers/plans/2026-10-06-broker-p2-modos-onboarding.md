# P2 C — Modos e onboarding observados

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans nesta sessão, inline, sem delegação de implementação.

**Goal:** Identificar o modo efetivo por caixa e orientar a configuração existente com evidências atuais e bloqueios explícitos.
**Architecture:** Perfil somente de leitura, vinculado à organização/canal, reutilizando destination approval, compatibility e autoridade residual. A tela encaminha para o onboarding durável existente; não cria um segundo provisionador nem faz chamadas externas na consulta. Transporte central nativo continua separado no P2 D.
**Tech Stack:** TypeScript, Zod, Fastify, React, PostgreSQL e Vitest.
**Spec:** ../specs/2026-10-05-broker-independente-centrais-design.md; parent 2026-10-05-broker-p2-independencia.md.

## Restrições globais
- Um único executor de bot por caixa; central indisponível nunca vira standalone.
- RLS, organização e canal são obrigatórios; IDs externos não autorizam acesso.
- Nenhum HTTP dentro de transação; UNKNOWN não autoriza repetir efeitos externos.
- Sem distribuição automática nova; implantação e homologação externa permanecem separadas.
- Não criar IDs fictícios de Account/Inbox nem alterar versões publicadas.
- Perfil não é autorização de execução nem comprovação de entrega; mudanças revalidam permissões nos serviços existentes.
- Mesmo Account/Inbox em hosts diferentes não compartilha escopo. Credencial e revisão de destino invalidam observações antigas.

## Foco da revisão
1. Conexão FAILED/DISABLED ou autoridade remota residual sem conta: BLOCKED, nunca STANDALONE.
2. QR público usa instance UUID; perfil resolve messagingChannelId em transação por organização, sem confundir IDs.
3. Origem managed diferente da configuração do servidor: modo não confirmado e bloqueado.
4. Observação signedCallback da credencial/revisão anterior: não confirma prontidão atual.
5. Troca de tenant/canal enquanto consulta está pendente: descartar perfil anterior; renderizar somente escopo exato.

## Task 1 — Perfil observado e API somente de leitura
**Files:** Create packages/contracts/src/channel-operation-profile.ts, apps/api/src/modules/channels/operation-profile.ts; update contracts/index.ts, channels/facade.ts, app.ts, http/routes/channels.ts, http/openapi.ts e inventory-routes.mjs. Test contracts, HTTP e integration/channel-operation-profile.test.ts.

**Interfaces:**
- ChannelOperationProfileSchema: schemaVersion 1, organizationId, channelId público, messagingChannelId nullable, observedAt, mode STANDALONE/JRC_MANAGED/CHATWOOT_EXTERNAL nullable, transport BROKER_TRANSPORT/CENTRAL_TRANSPORT nullable, readiness READY/BLOCKED/UNVERIFIED, blockers enum, central scope (origin, accountId, inboxId, integrationId, destinationRevision, credentialVersion) nullable; deliveryVerified literal false.
- createChannelOperationProfile({transact,managedOrigin?}).get(org,publicId): lê mapeamento QR/META atual, tenant ativo, catálogo de autoridade residual, contexto aprovado e compatibilidade exata; não retorna ciphertext, token, telefone completo nem payload.
- Facade.operationProfile delega ao serviço e a rota GET /v1/channels/:id/operation-profile exige JWT e OWNER/ADMIN atuais, no-store.
- BROKER_TRANSPORT identifica número cadastrado no Broker, não entrega comprovada. CENTRAL_TRANSPORT não é anunciado como implementado antes de D; executor legado/remoto mantém transport null e bloqueio.

- [x] RED para standalone sem central, conexão quebrada, autoridade órfã, origens distintas com Account/Inbox iguais, destino/credencial revogados, evidência antiga, canal estrangeiro e organização suspensa.
- [x] Confirmar falhas; implementar contrato e serviço sem escrita/HTTP.
- [x] RED HTTP current role/API key/no-store/escopo e projection sem segredo; implementar rota/policy/OpenAPI.
- [x] Rodar integrações PostgreSQL e revisão do incremento.

## Task 2 — Orientação na caixa e reutilização do onboarding
**Files:** Create apps/web/src/channels/ChannelOperationSetup.tsx e test; update ChannelDetail.tsx e channels/api.ts.

**Interfaces:**
- Consulta explícita pelo administrador, com cancelamento e chave org + tenantRevision + canal; schema e IDs exatos antes de renderizar.
- Checklist observado: conexão, atendimento local ou destino aprovado, conta/credencial, caixa/webhook/capacidades, automação, teste real. Links para /mensagens, /integracoes e /automations reutilizam os serviços existentes.
- Token/Account/Inbox continuam no onboarding existente; substituição de webhook exige ação explícita. Não emitir mutações nem fazer fallback ao clicar em consultar.
- Falha/UNVERIFIED explica pendências e preserva bloqueios. Nunca exibir grupos/chamadas como suportados a partir de mensagens.

- [x] RED troca de tenant/canal, resposta fora do escopo, erro sanitizado, modo bloqueado e links da jornada local/central.
- [x] Implementar UI acessível e seleção/orientação explícita sem provisionamento automático.
- [x] Build/typecheck, contratos/bundle, regressões e npm test antes do commit. Não repetir E2E completa local recusada.

## Task 3 — Evidência de isolamento e preparação externa
- [x] Revisar isolamento existente de catálogo, jobs, mídia e credenciais com origem/Account/Inbox/revisão; corrigir lacunas descobertas com RED. Callback de outra caixa não confirma esta integração; quatro testes RED/GREEN cobrem a lacuna.
- [x] Atualizar evidências distinguindo perfil observado, laboratório, CI, servidor e homologação externa.
- [x] Manter externos NOT_RUN até configuração no fim; P2 C não encerra D/E.

O incremento C1/C2 acima está verificado. O wizard integral para CENTRAL_TRANSPORT continua pendente de D; não se anuncia ativação deste transporte. Registro: ../../validation/2026-10-06-broker-p2-modos-onboarding.md.
