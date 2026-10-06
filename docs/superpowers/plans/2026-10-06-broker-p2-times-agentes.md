# P2 B — Times, agentes e atribuição manual

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans nesta sessão, inline, sem delegação de implementação. Esta entrega detalha B do programa já autorizado.

**Goal:** Completar o catálogo humano local e permitir transferência/atribuição para time ou agente da empresa.
**Architecture:** Identidades locais UUID usam memberships atuais do Broker; identidades remotas continuam no catálogo do adaptador da central. Persistir destino na sessão de atendimento existente, mantendo versão publicada e transferência transacional. Não criar um distribuidor automático.
**Tech Stack:** PostgreSQL com RLS, TypeScript, Zod, Fastify, React e Vitest.
**Spec:** ../specs/2026-10-05-broker-independente-centrais-design.md; parent plan 2026-10-05-broker-p2-independencia.md.

## Restrições globais
- Tenant ativo, canal ativo, sem central/autoridade residual para destino LOCAL.
- Usuário ativo e membership atual OWNER/ADMIN/OPERATOR; VIEWER não é atendente.
- Equipe local é da organização; nenhuma identidade Chatwoot numérica é convertida em UUID local.
- Uma fila local por canal; transferência para time sem membro elegível é rejeitada. QUEUE permite espera sem alegar que um agente respondeu.
- UNKNOWN remoto não é repetido. Histórico e versões publicadas não são alterados por edição de membros.
- Sem chamadas HTTP dentro das transações e sem novo executor.
- Migração versionada com RLS FORCE, lifecycle e permissões estreitas; jrc_app não ganha SELECT em users.

## Foco da revisão
1. VIEWER ou usuário desativado/removido após publicação: negar transferência e atribuição, suspender execução conforme falha local existente.
2. Time de outra empresa ou arquivado: negar sem revelar membros; RLS e FKs compostas.
3. Remoção do último membro elegível: catálogo não oferece o time; versão antiga não mantém autorização.
4. Atribuição concorrente à retomada/resolução: revisão da sessão e lock do canal impedem perda de estado.
5. Evento antigo ou resposta atrasada após troca de empresa: catálogo não muda o nó da nova empresa nem expõe nomes antigos.

## Task 1 — Persistência e catálogo elegível
**Files:**
- Create apps/api/drizzle/migrations/0045_local_attendance_directory.sql; update migrations/meta/_journal.json.
- Create apps/api/src/modules/attendance/local-directory.ts.
- Update apps/api/src/db/runtime-schema.ts and its structural-readiness tests to require baseline 0045, the directory tables/functions, session target columns and permissions.
- Update packages/contracts/src/attendance-destination-v2.ts.
- Test apps/api/tests/integration/local-attendance-directory.test.ts and packages/contracts/tests/attendance-destination-v2.test.ts.

**Interfaces:**
- LocalTarget = QUEUE | {kind:TEAM,teamId:UUID} | {kind:AGENT,agentId:UUID}; config retains handoffVersion 2 and destination organization/channel.
- Export the new target schema in Task 1, but keep the handoff config accepting only QUEUE until Task 3 wires target validation and storage. Never accept a TEAM/AGENT request that the current dispatcher would silently apply as QUEUE.
- local_attendance_teams(organization_id,id,name,status ACTIVE/ARCHIVED,revision,created_at,updated_at); local_attendance_team_members(organization_id,team_id,user_id), with tenant-bound membership and team FKs.
- attendance_sessions gains nullable local_team_id/local_agent_id with composite FKs and exclusion from remote sessions; team and agent mutually exclusive for this increment.
- current_local_attendance_members() returns user_id,email,role only for active current organization, active users/memberships and eligible roles; bounded 1001 rows, service rejects overflow.
- lock_local_attendance_member(UUID) revalidates/locks the current eligible identity through a narrow SECURITY DEFINER function. Preserve the established users-before-memberships lock order of identity administration.
- createLocalAttendanceDirectory({transact}).catalog(org,channel) returns scope, agents and active teams with eligible members; no credentials or password fields.
- assertLocalHumanTarget(tx,org,channel,target) validates and locks target/member eligibility; called in final publish, bind and handoff transaction.

- [x] Write RED: foreign tenant team/member, VIEWER, suspended user/org, inactive membership, empty/archived team, jrc_app cannot SELECT users, catalog overflow; target contract strict UUID union rejects numeric IDs.
- [x] Run focused tests and record the intended failure.
- [x] Implement migration/function/service and contracts, maintaining source/DB permissions and lifecycle purge catalogue.
- [x] Run focused tests and existing attendance/lifecycle migration regressions.

## Task 2 — Administration and manual assignment APIs
**Files:**
- Create apps/api/src/modules/attendance/local-directory-service.ts.
- Extend apps/api/src/http/routes/attendance-local.ts, app.ts, http/openapi.ts and scripts/security/inventory-routes.mjs.
- Test apps/api/tests/http/attendance-local-directory.test.ts and integration/local-attendance-assignment.test.ts.

**Interfaces:**
- OWNER/ADMIN list eligible members, create/rename/archive teams and replace team members with expected team revision; stale revision returns 409.
- GET /v1/attendance/local-channels/:channelId/catalog is no-store OWNER/ADMIN for Flow configuration.
- GET /v1/attendance/local-channels/:channelId/queue returns local waiting/human sessions, targets and current revisions to current OWNER/ADMIN/OPERATOR.
- POST /v1/attendance/local-conversations/:conversationId/assignment consumes expectedSessionId, sessionRevision and LocalTarget. OWNER/ADMIN may assign eligible targets; OPERATOR may claim only self, never assign another person. Resolve actor from current JWT/membership, not body. Compare session ID and revision under lock: a new cycle may reuse a revision number.
- Assignment must be a local live human session. Acquire channel and session locks, revalidate authority and eligibility, increment revision, record audited assignment. It cannot resume a bot or create an invented remote conversation.

- [x] Write RED for stale revision, other-org conversation/actor, API key, revoked membership, VIEWER, OPERATOR assigning another, response with no payload/secrets and no-store.
- [x] Run and confirm failures, implement services/routes/contracts and explicit policies.
- [x] Run PostgreSQL takeover/resolve/resume race tests and regenerate OpenAPI; check generated contract diff.

## Task 3 — Flow targets and local operator UI
**Files:**
- Update attendance/local-handoff.ts, handoff-readiness.ts, handoff-binding.ts and automations/engine.ts as necessary.
- Update web automations/api.ts and node-editors/LocalHandoffEditor.tsx; add attendance administration/queue components to existing Messaging UI, preserving current send/resume actions.
- Test LocalHandoffEditor.test.tsx, Messaging tests and standalone-handoff integration.

**Interfaces:**
- Flow editor loads the scoped local catalog and requires explicit QUEUE/TEAM/AGENT selection; changing channel clears incompatible IDs.
- Local handoff validates the target again, records target in WAITING_HUMAN atomically with receipt and bot pause; no false HUMAN_ACTIVE based only on assignment.
- Admin UI manages local teams and members; operator UI shows pending queue/assigned target and supports self-claim. Use current session revision and discard stale tenant requests.
- Claim confirmation opens the exact conversation through GET /v1/messaging/conversations/:id with no-store and public projection, independent of the 100-row listing. Capture navigation intent before the assignment POST; a later manual selection or assignment invalidates POST/GET responses. The queue is unavailable until the initial channel load finishes.

- [x] RED: saved numeric remote ID never becomes local agent; target revoked between publication and dispatch; archived/empty team; tenant switch with delayed response; stale session revision and keyboard operation.
- [x] Implement only enough to pass, including clear errors and no automatic distribution.
- [x] Verify the integrated journey for team and direct agent, human reply and explicit resume; preserve QUEUE and remote V1 behavior.
- [x] Run build/typecheck, npm test, relevant PostgreSQL integrations, bundle and diff checks; independent review then commit. Do not rerun the previously declined full local E2E suite without new authorization.

External validation is still NOT_RUN. At the end, configure the JRC A/B and external Chatwoot profiles per the homologation preparation guide and repeat the customer journey through the integrated Flow/QR UI.
