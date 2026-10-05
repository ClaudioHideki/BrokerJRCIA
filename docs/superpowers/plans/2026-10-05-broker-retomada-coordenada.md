# Retomada coordenada do atendimento — plano de implementação P1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans para executar tarefa por tarefa nesta sessão. TDD obrigatório.

**Goal:** Corrigir a divergência BOT local/HUMAN remoto e tornar retomada, bloqueio e primeira transferência observáveis e testáveis.
**Architecture:** Operação persistente de retomada, com idempotência e revisão, seguindo o padrão de handoff já existente. HTTP fora da transação; controle só é liberado após confirmação e revalidação. Não modificar diretamente registros reais para contornar o gate.
**Tech Stack:** TypeScript, Fastify/Zod, PostgreSQL/Drizzle, workers existentes, React, Vitest e Playwright.
**Spec:** [Desenho](../specs/2026-10-05-broker-independente-centrais-design.md), seções 3–5 e 9.

## Restrições globais

- Um único executor de bot por caixa.
- Nenhuma chamada externa dentro de transação de banco.
- Não reenviar resultados desconhecidos sem reconciliação.
- Humano prevalece sobre efeito automático ainda não despachado.
- Nenhum segredo, telefone ou payload real em Git.
- Desenvolvimento local, CI e implantação são estados distintos.
- Release de produção exige tarefa explicitamente aprovada.

## Foco da revisão

1. Resposta humana entre leitura remota e commit: invalida operação — tarefa 3.
2. Retomada de conversa legada sem sessão: somente NEW_SESSION cria ciclo — tarefas 1/2.
3. Mesmo POST repetido após timeout: mesma operação, sem nova sessão — tarefa 2.
4. Versão de fluxo ou credencial muda com diálogo aberto: conflito orientado — tarefas 2/4.
5. Efeito antigo já despachado: não afirmar cancelamento nem repetir — tarefas 3/5.

## Base observada e reproduzida por inspeção

- messaging/service.ts:setMode muda modo para BOT sem coordenar chatwoot_attendance_controls.
- control-service.ts exige READY, modo BOT, escopo válido e ausência de pendências.
- Produção diagnosticada: QUEUED, attempts=0, local permitido e remoto HUMAN; sessão ausente.
- Contratos de ResumeTarget já existem; endpoint de retomada de execução não equivale a retomada de atendimento.
- O plano R5 anterior propunha retorno síncrono de AttendanceSession. Este incremento substitui aquela proposta por operação consultável, porque a escrita remota pode ter resultado desconhecido.

## Interfaces do candidato local

Implementadas neste incremento; não presumir que estejam disponíveis no servidor antes da release. O [registro de execução](../../validation/2026-10-05-broker-retomada-coordenada.md) contém os resultados e limites de P1.

Tipos de contrato em packages/contracts/src/attendance-resume-v1.ts:
- ResumeAttendanceInput = { conversationId: string; expectedControlRevision: number; expectedOwnerRevision: number; target: ResumeTarget }.
- ResumeOperationState = 'PENDING' | 'APPLIED' | 'UNKNOWN' | 'ACTION_REQUIRED' | 'CANCELED'.
- ResumeOperationView = { id: string; state: ResumeOperationState; conversationId: string; sessionId: string | null; errorCode: string | null }.
- Identidade do ator e organização vêm da sessão autenticada, nunca do corpo.
- Idempotency-Key é obrigatório, com hash do corpo. Mesma chave/corpo retorna operação existente; mesma chave/outro corpo gera 409.
- POST /v1/attendance/conversations/:id/resume recebe input sem conversationId duplicado no corpo, retorna 202 + ResumeOperationView.
- GET /v1/attendance/resume-operations/:id retorna 200 + ResumeOperationView apenas no tenant e papel autorizados.
- GET /v1/attendance/conversations/:id/resume-context retorna diagnóstico, revisões e alvos compatíveis para o diálogo.
- requestAttendanceResume(org: string, actorId: string, idempotencyKey: string, input: ResumeAttendanceInput): Promise<ResumeOperationView>.
- processAttendanceResume(operationId: string, organizationId: string): Promise<ResumeOperationView>.
- readAttendanceDiagnostic(tx: TenantTransaction, input: AttendanceGateInput): Promise<AttendanceDiagnostic>.
- AttendanceDiagnostic = { allowed: boolean; reason: 'NONE' | 'HUMAN_CONTROL' | 'REMOTE_INITIALIZING' | 'REMOTE_RECONCILE' | 'REMOTE_PAUSED' | 'LOCAL_HUMAN' | 'SCOPE_CHANGED' | 'OWNER_CHANGED' | 'SESSION_PAUSED'; controlRevision: number; cycle: number | null }.

Reutilizar ResumeTarget/AttendanceGateInput já existentes. Diagnóstico deve expor bloqueio sem dados sensíveis; não é autorização duradoura de envio.

## Tarefa 1 — regressão e contratos

Arquivos:
- Criar packages/contracts/src/attendance-resume-v1.ts e packages/contracts/tests/attendance-resume-v1.test.ts.
- Modificar packages/contracts/src/index.ts.
- Criar apps/api/tests/unit/attendance-resume-policy.test.ts e apps/api/src/modules/attendance/resume-policy.ts.
- Ampliar apps/api/tests/unit/messaging-service.test.ts.

Interface: validateResumeTarget(input: { target: ResumeTarget; hasActiveSession: boolean; hasCompatibleCursor: boolean; hasPublishedAutomation: boolean }): void; erros de domínio seguros.

- [x] Escrever testes red: CONTINUE sem sessão rejeita ATTENDANCE_RESUME_CURSOR_UNAVAILABLE; MENU exige nó menu da versão; NEW_SESSION sem versão publicada rejeita AUTOMATION_NOT_PUBLISHED.
- [x] Escrever regressão: solicitação BOT em conversa com controle HUMAN não pode retornar sucesso de bot ativo só alterando messaging_conversations.
- [x] Rodar npm test -- packages/contracts/tests/attendance-resume-v1.test.ts apps/api/tests/unit/attendance-resume-policy.test.ts apps/api/tests/unit/messaging-service.test.ts; confirmar falha funcional/contrato ausente.
- [x] Implementar schemas strict, limites e política; nenhuma chamada remota nesta unidade.
- [x] Repetir testes; exigir PASS. Preservar HUMAN manual e contratos não afetados.
- [x] Executar npm test e git diff --check --ignore-submodules antes de commit focado.

## Tarefa 2 — operação durável e isolamento

Arquivos:
- Criar apps/api/src/modules/attendance/resume-repository.ts e resume-service.ts.
- Criar apps/api/tests/integration/attendance-resume.test.ts.
- Modificar apps/api/src/modules/attendance/repository.ts quando necessário para resolver conversa legada.
- Adicionar migration/manifesto/runtime-schema conforme próximo número livre verificado em P0; nome funcional attendance_resume_operations. Não escrever número concorrente com migrations locais existentes.

Persistência: organização, conversa, canal, ator, chave/hash, estado, revisões capturadas, ciclo, snapshot saneado da intenção, lease e resultado. Chaves e policies seguem tabelas de handoff existentes.
Consulta retornará referências locais; credencial resolvida apenas na execução.

- [x] TDD em PostgreSQL: tenant B não consulta operação de A; mesma chave/corpo retorna mesmo id; corpo distinto dá 409; revisão obsoleta não cria comando.
- [x] Testar sessão ausente com NEW_SESSION reserva intenção sem liberar bot; operação duplicada não cria dois ciclos.
- [x] Rodar npm run test:integration -- apps/api/tests/integration/attendance-resume.test.ts; registrar falha inicial em banco descartável.
- [x] Implementar reserva idempotente e RLS, respeitando ordem de locks existente: organização/instância/canal antes de execução/conversa.
- [x] Testar upgrade vazio/baseline, grants exatos, rollback de transação e corrida de dois operadores.
- [x] Repetir teste focado; suíte geral/diff antes de commit. Falta de banco de laboratório é BLOCKED, nunca SKIPPED aprovado.

## Tarefa 3 — coordenação e reconciliação remota

Arquivos:
- Criar apps/api/src/modules/attendance/resume-worker.ts.
- Modificar apps/api/src/modules/integrations/chatwoot-attendance-service.ts e chatwoot-attendance-store.ts.
- Modificar apps/api/src/modules/attendance/control-service.ts e manual-takeover.ts.
- Integrar processamento no worker existente apropriado, preservando justiça por organização.
- Criar apps/api/tests/integration/attendance-resume-concurrency.test.ts e apps/api/tests/unit/attendance-resume-reconciliation.test.ts.

Interfaces: processAttendanceResume e repositório da tarefa 2. Capturar intenção/revisão antes do HTTP; operação APPLIED não repete efeito.

- [x] TDD: confirmação remota permite READY/BOT e ciclo válido; erro antes de despacho permanece bloqueado; timeout após despacho produz UNKNOWN.
- [x] Testar humano durante HTTP, troca de token, exclusão/alteração do binding, evento pending atrasado e mensagens do ciclo anterior.
- [x] Rodar testes com unitários e npm run test:integration -- apps/api/tests/integration/attendance-resume-concurrency.test.ts; confirmar regressões.
- [x] Implementar preparo → despacho → observação → confirmação. Não manter conexão transacional aberta durante rede.
- [x] Reconciliar UNKNOWN por leitura autoritativa e evidência da operação, sem inferir autoria apenas por igualdade de status; inconclusivo vira ACTION_REQUIRED.
- [x] Em controle remoto insuficiente, mostrar incompatibilidade e manter bloqueio. Não desabilitar o gate nem depender só de status pending.
- [x] Confirmar revalidação no despacho de efeitos automáticos. Limitação de CAS no servidor externo deve constar nos testes e matriz.
- [x] Repetir testes; suíte geral/diff antes de commit.

## Tarefa 4 — API e interface sem falso sucesso

Arquivos:
- Criar apps/api/src/http/routes/attendance-resume.ts.
- Integrar em apps/api/src/app.ts.
- Modificar apps/api/src/http/routes/messaging.ts e modules/messaging/service.ts.
- Modificar apps/web/src/pages/Messaging.tsx e Messaging.test.tsx.
- Criar apps/api/tests/http/attendance-resume.test.ts.
- Atualizar docs/api/openapi.json por gerador.

- [x] TDD HTTP: 401 sem sessão, 403 sem papel, 404 para conversa alheia, 409 para revisão divergente, idempotência obrigatória.
- [x] TDD UI: diálogo escolhe continuar/menu/nova sessão, explica cursor indisponível, mostra retomada pendente e só exibe bot ativo após confirmação.
- [x] Rota legada BOT com central não pode contornar serviço; retornar ATTENDANCE_RESUME_REQUIRED quando faltar intenção/revisão. Atualizar cliente junto para evitar regressão.
- [x] Implementar POST/GET e UI consumindo os contratos; bloquear duplo clique sem depender do bloqueio visual para idempotência.
- [x] Rodar npm test -- apps/api/tests/http/attendance-resume.test.ts apps/web/src/pages/Messaging.test.tsx.
- [x] Gerar OpenAPI após build, conferir contratos e acessibilidade por teclado; suíte geral/diff antes de commit.

## Tarefa 5 — diagnóstico e jornada completa

Arquivos:
- Criar apps/api/src/modules/attendance/diagnostics.ts.
- Modificar apps/api/src/modules/automations/service.ts e packages/contracts/src/automations-v1.ts para diagnóstico adicional compatível.
- Modificar apps/web/src/pages/AutomationStudio.tsx e AutomationStudio.test.tsx.
- Criar apps/api/tests/unit/attendance-diagnostics.test.ts e apps/web/tests/e2e/attendance-resume.spec.ts.
- Ampliar apps/api/tests/integration/automation-native-journey.test.ts.

- [x] Testar HUMAN_CONTROL com attempts=0: UI mostra bloqueio e ação correta; não representa envio falho.
- [x] Testar causas concorrentes com prioridade definida: escopo/propriedade inválido antes de recomendar retomada; humano antes de espera.
- [x] Criar fluxo sintético início → menu → captura → handoff real, usando catálogo de laboratório, mais ramo de erro/silêncio.
- [x] Testar humano responde, bot para, operador retorna ao menu, cliente responde e automação continua no ciclo correto.
- [x] Testar reinício de worker, callbacks atrasados, duplicatas, conversa sem sessão e efeito antigo UNKNOWN; reconexão do aparelho e resolução/reabertura completas continuam no aceite externo.
- [x] Rodar unitários, integração focal e E2E com fixture local. Depois build/typecheck/suíte geral e diff.
- [x] Atualizar documento de evidência com resultado real por camada; preparar release, não implantar automaticamente.
- [ ] Após release autorizada em ambiente de teste, executar mensagem real na caixa exclusiva e conferir dispositivo/central/Broker. Sem essa prova P1 permanece não homologado.

## Comandos de verificação

Decisões de execução: a política inclui `hasMenuNode`; reconciliação foi testada em PostgreSQL no arquivo de concorrência, em vez de outro mock unitário; a jornada ampliou `native-handoff.test.ts`; a UI ganhou diálogo e testes próprios. Silêncio em P1 mantém a espera EVENT sem consumir resposta vazia; timeout configurável de resposta pertence a P3. O incremento será registrado como um candidato coeso de contrato/migration/worker/API/UI, preservando os ciclos RED/GREEN por tarefa no ledger.

Na raiz do worktree, com dependências do lockfile:
- npm test -- apps/api/tests/unit/attendance-resume-policy.test.ts
- npm run test:integration -- apps/api/tests/integration/attendance-resume.test.ts apps/api/tests/integration/attendance-resume-concurrency.test.ts
- npm run test:e2e -- apps/web/tests/e2e/attendance-resume.spec.ts
- npm run build
- npm run typecheck
- npm test
- git diff --check --ignore-submodules

Arquivos de teste propostos só devem ser executados após criados no ciclo TDD. Integração usa exclusivamente PostgreSQL/Redis descartáveis configurados pelos helpers atuais.
