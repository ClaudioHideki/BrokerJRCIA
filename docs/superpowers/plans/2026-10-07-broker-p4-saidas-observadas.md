# P4.1 — Saídas QR observadas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans para executar tarefa por tarefa, com RED/GREEN e ledger. Esta entrega não autoriza commit, push, branch ou produção.

**Goal:** Persistir saídas individuais observadas no WhatsApp, correlacionar ecos por provider ID e espelhar saídas externas sem reenvio ou atribuição fictícia.

**Architecture:** Observações ficam em tabela própria antes do ACK. O envio conserva uma tentativa durável antes de I/O; somente o ID retornado pelo provedor confirma correlação. O worker reconcilia evidências conhecidas. Resultado desconhecido permite abandono administrativo explícito, mantém a incerteza e nunca autoriza retry.

**Tech Stack:** Node 24.19.0, TypeScript, PostgreSQL/Drizzle, Fastify/Zod, Vitest, React.

**Spec:** [Desenho aprovado](../specs/2026-10-05-broker-independente-centrais-design.md), seção 7, e [programa](2026-10-05-broker-programa-integracao.md), P4.

## Restrições globais

- Reutilizar checkout main autorizado, sem branch adicional, commit ou publicação nesta subtarefa.
- Não alterar automations, Studio, catálogo, FlowCanvas, OpenAPI ou inventário de segurança.
- Um executor por caixa; humano confirmado prevalece. Origem EXTERNAL_OBSERVED não inventa agente ou HUMAN_ACTIVE.
- Escopo organização/conexão obrigatório, RLS forçado e credenciais exclusivamente no servidor.
- Nenhum HTTP dentro de transação; UNKNOWN não é reenvio seguro.
- Nenhum payload, telefone real, segredo ou estado de autenticação em fixtures/Git.
- Migration 0049 reservada após confirmar journal local 0048_central_cutover (idx 47).
- Testes focados nesta subtarefa; suites completas e gerados pertencem ao root.
- Integrações somente em PostgreSQL sintético isolado, depois de coordenação explícita com root.

## Foco da revisão

1. Eco chega antes do ACK: observação separada, sem colisão de ID canônico e sem humano falso.
2. Persistência do ACK falha: tentativa permanece incerta, sem classificação por conteúdo/tempo/dispositivo.
3. Humano age durante I/O: remover barreira de eco não retoma controle por cima do humano.
4. Mesmo provider ID em conexões/empresas diferentes: nenhuma correlação ou mídia cruzada.
5. Abandono e eco tardio: preservar UNKNOWN, não espelhar possível duplicata nem converter indício em prova.

## Task 1 — Normalização e origem pública

**Files:** messaging/qr-events.ts; messaging/types.ts; contracts/src/messaging/schemas.ts; messaging/service.ts; tests/unit/qr-events.test.ts; tests/unit/qr-outbound-origin.test.ts.

**Interfaces:** `QrEvent` adiciona `kind:'outbound'|'outbound-media'` com provider ID, destinatário e conteúdo compatível. `MessageSource` adiciona `EXTERNAL_OBSERVED`; `MessageView` expõe `source` sem exigir agente.

- [x] Escrever casos fromMe texto/mídia, LID alternativo e histórico/grupo ignorados; verificar RED pelo descarte antigo.
- [x] Implementar saída observada sem alterar entrada/status/histórico.
- [x] Expor origem no contrato e messageView; verificar GREEN focado.

## Task 2 — Persistência e correlação antes/depois do ACK

**Files:** drizzle/migrations/0049_qr_outbound_observations.sql; journal; db/schema.ts; messaging/qr-outbound-observation.ts; messaging/qr-service.ts; messaging/repository.ts; tests/integration/qr-outbound-observation.test.ts. Readiness estrutural pertence ao root.

**Interfaces:** `recordQrOutboundObservation(tx,input)` retorna observação; `settleQrOutboundObservation(tx,org,id)` usa somente provider ID. `beginQrDispatchAttempt` e `completeQrDispatchAttempt` conservam tentativa por mensagem/lease. Mensagem observada externa é OUTGOING/EXTERNAL_OBSERVED sem outbox.

- [x] Escrever integração de aparelho/eco antes do ACK; observar RED pelo descarte da saída do aparelho.
- [x] Criar tabelas com FKs compostas, RLS/grants e índices, preservando tentativas legadas SENDING/UNKNOWN.
- [x] Registrar tentativa na validação imediatamente anterior ao HTTP; correlacionar ACK na mesma transação que completeSend.
- [x] Persistir observação no ingress; materializar saída externa somente sem tentativas incertas, com mídia privada e pausa conservadora.
- [x] Testar duplicata/reinício/IDs entre tenants e falha de confirmação; histórico continua ignorado na normalização.

## Task 3 — Barreiras, recuperação e espelhamento

**Files:** messaging/worker.ts; attendance/control-service.ts (gancho); messaging/repository.ts; messaging/service.ts; http/routes/messaging.ts; contracts/src/messaging/schemas.ts; integrations/chatwoot-worker.ts; tests/http/qr-outbound-observation.test.ts; integrações focadas.

**Interfaces:** `recoverQrOutboundObservations(tx,org,limit=20)` resolve IDs conhecidos e torna tentativa expirada UNKNOWN. `listQrOutboundObservations` expõe motivo, revisão e ação. `abandonQrOutboundObservation` exige admin atual, revisão, razão e conjunto atual completo de tentativas incertas; recusa DISPATCHED e nunca altera UNKNOWN para SENT nem cria outbox. Tentativa abandonada continua evidência de origem incerta para ecos tardios.

**Reparo de revisão:** `listQrDispatchAttempts` e `abandonQrDispatchAttempt` dão recuperação administrativa a UNKNOWN sem eco. A tentativa usa revisão CAS, membership atual, auditoria e guarda de mensagem UNKNOWN sem providerID/outbox; nenhuma observação é fabricada. Expiração QR pertence exclusivamente ao recoverer com lock do canal, removendo disputa inversa com claimOutgoing. Seleção justa é travada em ordem comum de canal. Lista prioriza pendências, e o retorno de abandono usa ID específico fora da janela de 100 registros. `message-state.ts` compartilha transições e lock por providerID; estados persistidos antecipadamente são reaplicados antes da materialização externa.

- [x] Acrescentar casos de barreira e recuperação; observar RED da operação de abandono ausente.
- [x] Bloquear novas saídas automáticas e conclusão de turnos enquanto observações exigem reconciliação.
- [x] Acrescentar listagem e abandono autenticados com escopo/revisão/auditoria; recusar abandono de I/O ainda ativo.
- [x] Permitir operação posterior à desistência explícita sem retry do envio abandonado; conservar eco tardio sem classificação automática.
- [x] Espelhar EXTERNAL_OBSERVED com origem explícita; RED mostrou texto sem rótulo/origem; reusar ledger de eco Chatwoot.
- [ ] Root: regressão ampla do ledger Chatwoot existente, incluindo callback durante POST, e revisão independente.

## Task 4 — Apresentação e validação local

**Files:** apps/web/src/pages/Messaging.tsx e testes pertinentes; docs/validation/2026-10-07-broker-p4-saidas-observadas.md.

- [x] Escrever RED para rótulo de saída observada e cobertura da ação visível de pendência/abandono sem agente fictício.
- [x] Implementar apresentação no console de mensageria, sem tocar interfaces Flow.
- [x] Executar grupos focados de normalização, mensageria, espelhamento, HTTP/UI e PostgreSQL isolado; registrar resultados.
- [x] `git diff --check` com submódulos ignorados passou; revisão e typecheck coordenados com root.
- [ ] Root: typecheck/build, readiness, inventário/OpenAPI gerados e validação integrada final.

## Critério de saída

P4.1 local: texto/mídia suportados do aparelho aparecem uma vez; eco conhecido reutiliza mensagem original; dúvida permanece visível e reconciliável/abandonável sem reenvio. P4 completo continua pendente de homologação real aparelho → Broker → JRC/Chatwoot por versão e conexão.

## Task 5 — Revisão de quotas de admissão

**Files:** migration0049; tests/integration/qr-outbound-observation.test.ts; ledger. Não editar completeSend, meta/readiness ou gerados pertencentes ao root.

**Contrato:** EXTERNAL_OBSERVED registra um fato externo autenticado e não admite novo envio do Broker. Ruling refinado do root: retornar cedo para INCOMING ou OUTGOING/EXTERNAL_OBSERVED antes de ACTIVE/quotas, igual ao ingresso CONTACT existente. Excluir essa origem das contagens de pendências. ACTIVE/quotas continuam exigidos para OPERATOR/AUTOMATION e novos recursos; preservar lifecycle, constraint de direção/origem, RLS, owner/grants e limites existentes de mídia.

- [x] RED texto e mídia com limite diário/pending já cheio: fato observado persiste, uma observação, pausa, nenhum outbox e usage de admissão inalterado.
- [x] Implementar função do trigger via migration0049 sem alterar migrations publicadas; verificar recusa OPERATOR/AUTOMATION e quota de mídia existente.
- [x] Testar suspensão explicitamente: entrada conserva comportamento atual; fato externo persiste com pausa conservadora, sem outbox/AI/envio e sem revogar controle humano; OPERATOR/AUTOMATION continuam recusados.
- [x] GREEN focado no banco isolado; avisar root para repetir upgrade0049 e sua validação integrada.

## Task 6 — Fence de ingresso das observações

**Files:** somente migration0049 e integração P4; atualização deste plano/ledger. Não editar completeSend ou readiness/meta do root.

**Contrato:** resolver o canal antes de uma exclusão não autoriza novo ingresso depois da fence. QR_OUTBOUND_OBSERVATIONS precisa da mesma guarda lifecycle BEFORE INSERT das tabelas de ingresso. UPDATE de registros existentes permanece permitido para ACK/abandono explícito e drenagem; nenhum novo efeito externo é iniciado.

- [x] RED com binding resolvido antes de deleting_at e eco novo liberado depois, em DISPATCHED/UNKNOWN/ABANDONED que retornariam RECONCILE sem INSERT canônico.
- [x] Adicionar somente trigger BEFORE INSERT reusando lifecycle_reject_channel_write, sem alterar função/ACL nem bloquear UPDATE.
- [x] Testar drenagem de ACK SENT com provider ID conhecido e abandono do ledger existente depois da fence, sem registro/canonical/outbox novos.
- [x] GREEN P4 + upgrade0049 + readiness pertinentes em bancos isolados; comunicar migration estável ao root.

## Task 7 — ACK rejeitado durante drenagem lifecycle

**Files:** qr-outbound-observation.ts, integração P4 e somente novo motivo no contrato/UI/teste de observações, autorizados pelo root; plano/ledger. Não alterar completeSend, migrations, readiness ou gerados do root.

**Contrato:** resultado final FAILED/REJECTED ou SENT/CONFIRMED de tentativa já despachada deve persistir depois da fence, mesmo quando existe observação anterior de providerID diferente. Revalidar a admissão factual pelo resolvedor DB existente, sob lock do canal, antes de pausar/materializar. Ruling refinado: sem tentativa DISPATCHED/UNKNOWN e sem canal resolvível, a observação continua RECONCILE com blocking=false e QR_LIFECYCLE_RECONCILE, sem exigir abandono administrativo (organização DISABLED não permite essa operação HTTP); permitir drenagem autorizada, sem mensagem/outbox/espelho/reenvio. UNKNOWN continua bloqueante e não vira certeza por causa da fence. Suspensão continua aceitando ingresso factual. Guarda não suprime ou contorna triggers lifecycle; contrato/UI recebem apenas o novo motivo, autorizados pelo root.

- [x] RED canal e organização na condição real de exclusão restaurada, com um eco anterior distinto e nenhuma tentativa incerta adicional; real API preflight conserva recusa do despacho ativo.
- [x] Preservar FAILED/REJECTED ou SENT/CONFIRMED, remover outbox e impedir materialização da observação anterior após fence.
- [x] Verificar pending_count zero e purge autorizado depois de resultado final; preservar UNKNOWN bloqueante/purge recusado, sem reenvio/AI/autoria inventada nem retomar humano.
- [x] GREEN focal PostgreSQL e comunicação da fonte estabilizada ao root para revisão/build/global.

- [x] Revisão independente final PASS, sem novos achados; source, migration e fixtures congelados em 08/10/2026. Focais finais: PostgreSQL 36/36, UI 38/38 e HTTP 25/25. Root mantém ownership da regeneração OpenAPI e validação integrada global; homologação real P4 continua pendente.
