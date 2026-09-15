# Broker completo JRC — Implementation Plan

> **For agentic workers:** executar tarefa por tarefa com superpowers:executing-plans e TDD. Revisões por lote. Nenhum staging, commit, push, PR, merge ou deploy está autorizado por este documento.

**Goal:** entregar operação multicliente por console, mensageria, Meta/templates, Typebot, canvas próprio, atendimento e controles comerciais.
**Architecture:** monólito modular existente com adapters de provider, inbox/outbox PostgreSQL, workers e fila RabbitMQ; UI React. Módulos conversacionais não vazam para o contrato do provider.
**Tech Stack:** Node 24.19.0, TypeScript strict, Fastify, Drizzle/PostgreSQL, Zod, React/Vite, Redis, Vitest e Playwright; dependências novas fixadas somente após validar compatibilidade/licença.
**Spec:** docs/superpowers/specs/2026-09-06-complete-broker-design.md

## Restrições globais

- Preservar as alterações não publicadas da console no worktree atual. Não copiar uma base antiga e perder trabalho.
- Não alterar main ou upstream/evolution-api, nem atualizar silenciosamente imagem/versão da engine.
- organization_id obrigatório, RLS deny-by-default, SQL parametrizado, transações curtas e chamadas externas fora do banco.
- Credenciais somente no ambiente/secret manager; tokens em hash ou criptografia conforme finalidade; logs e evidências sanitizados.
- Não promover OWNER a administrador global. Não usar recursos de clientes como teste.
- Registrar RED, GREEN, comandos/resultados e pendências reais. Nenhum checkbox concluído apenas por existência de arquivo.
- A lista abaixo é o plano integrado de entregas. Antes de cada novo subsistema, detalhar o contrato com sua versão e fixtures reais sanitizadas em um plano de lote; decisões externas não são substituídas por mocks.

## Estado inicial e acompanhamento

Base publicada: 159ddfc18ed110957849e43e1825ef6c31ca3cd3; branch codex/phase-1-web-console. Console anterior tem 164 arquivos novos/modificados ainda não staged. Seu último gate tinha 550 testes gerais, 120 integrações e homologação humana pendente.

- [x] Ler arquitetura, spec/plano da console e AGENTS; executar fetch preservando o working tree.
- [x] Registrar ampliação explícita para canvas/atendimento em especificação complementar.
- [ ] B01 conexão: diagnóstico, correções demonstradas e testes automatizados.
- [ ] B01 conexão: pareamento humano e confirmação de CONNECTED.
- [ ] B02 administração de clientes e identidades.
- [ ] B03 mensageria/eventos/mídia.
- [ ] B04 Meta/templates.
- [ ] B05 Typebot.
- [ ] B06 canvas.
- [ ] B07 atendimento.
- [ ] B08 comercial/operação e homologação final.

## Ciclo obrigatório por tarefa

1. Escrever teste de comportamento que falha pelo recurso ausente ou pelo defeito reproduzido.
2. Executar o arquivo focalizado e registrar a falha esperada, sem segredos.
3. Implementar o mínimo; executar focalizado até GREEN e typecheck.
4. Integrações com PostgreSQL real quando houver persistência/RLS; HTTP com composição real; UI com Testing Library e E2E nas jornadas entregues.
5. Atualizar composição apps/api/src/app.ts e apps/web/src/app/App.tsx em cada tarefa com rotas; atualizar OpenAPI e inventário.
6. Revisar lote, corrigir achados e repetir gates afetados; registrar diff e resultados. Publicação somente mediante autorização específica.

## B01 — Conexão WhatsApp utilizável

### Task 1: Diagnóstico sanitizado e escolha explícita de modalidade

**Arquivos:** apps/web/src/pages/ConnectionDetail.tsx; apps/web/src/connections/components/ChallengePanel.tsx; respectivos testes; packages/providers/src/evolution/{mappers,evolution-provider-adapter}.ts e testes somente se o diagnóstico demonstrar defeito.
**Consome:** ConnectInstanceRequest e ConnectionAction existentes.
**Produz:** solicitação QR sem pairingHint e pareamento com número explícito, mantendo idempotência por intenção.

- [x] Consultar apenas estado/código de desconexão e presença de desafio; nunca imprimir desafio, telefone ou credencial.
- [x] Testar que QR não envia número residual; modalidade por código exige número e orienta vínculo por número no aparelho.
- [x] Testar troca de modalidade limpa desafio/intenção, valida formato, reenvio incerto mantém chave e VIEWER não pode mutar.
- [x] Implementar escolhas acessíveis e mensagens específicas sem alterar contratos públicos já consumidos.
- [x] Executar os testes de ConnectionDetail, ChallengePanel e EvolutionProviderAdapter (incluídos também na suíte geral).
- [ ] Rodar smoke isolado com finally/deprovision/lookup; aguardar ação humana para a homologação real sem travar o restante do desenvolvimento.

### Task 2: Recuperação operacional e diagnóstico de conexão

**Registro parcial B01 — 2026-09-06:** RED observado para escolha de modalidade ausente e botão de atualização ausente; GREEN focalizado 21 testes. Suíte geral: 77 arquivos / 552 testes aprovados. Typecheck e build aprovados; npm audit --audit-level=high: zero vulnerabilidades. Jornada Playwright de criar/conectar QR e pairing/status/desconectar: 1 teste aprovado com PostgreSQL/Redis reais e adapter falso. A fixture de número é fictícia e exclusiva do adapter falso. Nenhuma conexão WhatsApp real foi comprovada por esse E2E. Diagnóstico somente leitura encontrou CONNECTING local e close/401 no upstream; a causa do 401 permanece não demonstrada. O smoke isolado, a revisão do lote e a homologação humana permanecem pendentes. Primeira execução geral esbarrou em ownership Git; repetição passou com safe.directory limitado ao processo e diretórios conhecidos, sem configuração global. Relatório de segurança anterior é histórico, não certifica esta ampliação. B02–B08 ainda não implementados.

**Arquivos:** apps/api/src/modules/instances/{service,repository}.ts; apps/web/src/pages/ConnectionDetail.tsx; apps/api/tests/{unit/instance-service.test.ts,integration/connection-leases.test.ts}; apps/web/src/pages/ConnectionDetail.test.tsx.
**Consome:** status, lease/idempotency e getStatus existentes.
**Produz:** atualização explícita de status e tentativa recuperável depois de expiração comprovada, sem operações concorrentes.

- [ ] RED: estado local CONNECTING e upstream fechado após lease vencido deve convergir; requisição anterior em voo não deve sobrescrever geração nova.
- [ ] RED: erro de rede permite consulta manual mesmo após encerramento de polling; nenhuma resposta antiga troca o tenant.
- [ ] Corrigir somente diferenças observadas; preservar lock/fencing e provider fora da transação.
- [ ] GREEN unitário/integração e cenário real sanitizado; registrar causa comprovada versus hipóteses externas.

## B02 — Administração de clientes e identidades

### Task 3: Privilégio explícito da plataforma

**Criar:** apps/api/src/modules/platform/{authorization,repository}.ts; apps/api/src/commands/platform-admin.ts; migration SQL versionada seguinte ao journal atual; testes unitários/integração platform-authorization.
**Modificar:** composição/config da API, contratos de sessão, grants mínimos de autenticação.
**Contrato:** `requirePlatformPermission(userId, permission)` revalida concessão ativa no servidor; `platform:clients:read/create/suspend` não são scopes de API key de tenant.

- [ ] RED: OWNER/ADMIN/OPERATOR/VIEWER sem concessão explícita recebem 403; API key é recusada; concessão revogada não pode ser reutilizada com JWT ainda válido.
- [ ] RED: role jrc_app não lê nem altera concessões; nenhuma função SECURITY DEFINER aceita concessão arbitrária pelo chamador; search_path fixado e EXECUTE revogado de PUBLIC.
- [ ] Implementar tabela/grants e comando de concessão/revogação com confirmação operacional, auditoria e verificação de usuário ativo.
- [ ] GREEN com PostgreSQL e duas organizações; não conceder administração automaticamente no bootstrap de cliente.

### Task 4: Cadastro/listagem de clientes pela API e pela tela

**Criar:** apps/api/src/http/routes/platform-clients.ts; apps/api/src/modules/platform/clients.ts; packages/contracts/src/platform/schemas.ts; apps/web/src/pages/admin/{Clients,NewClient}.tsx; testes HTTP, integração e componentes.
**Modificar:** apps/api/src/app.ts; apps/web/src/{app/App,layout/AppShell}.tsx; OpenAPI/exports.
**Rotas:** GET/POST /v1/platform/clients; POST /v1/platform/clients/:id/suspend; listagem com cursor e limite.

- [ ] RED: usuário sem grant não cadastra; dois POST com mesma chave criam um único cliente; slug duplicado retorna conflito sem expor PII.
- [ ] Reutilizar invariantes de tenant:create, criando organização/OWNER/account/auditoria atomicamente. E-mail existente exige LINK_EXISTING explícito; senha nunca é redefinida.
- [ ] Usar conexão/role administrativa limitada e isolada da role normal; não conceder BYPASSRLS à API de clientes.
- [ ] Tela acessível com confirmação, estado vazio/erro, suspensão e suporte por request_id; nenhuma senha em URL/storage.
- [ ] GREEN: cadastrar dois clientes, entrar com cada um e provar isolamento; suspensão invalida acesso no servidor.

### Task 5: Convites, verificação de e-mail e recuperação

**Criar:** apps/api/src/modules/identity/{invitations,email-verification,password-reset}.ts; apps/api/src/modules/email/{port,smtp-adapter}.ts; rotas identity; contratos; telas AcceptInvite/VerifyEmail/ResetPassword; migrations e testes.
**Contrato:** tokens opacos com hash, finalidade, expiração e consumo único. E-mail enviado após commit pelo outbox.

- [ ] RED: replay/concorrência/expiração/finalidade errada, enumeração e rate limit; senha redefinida revoga sessões.
- [ ] Implementar convites sem senha provisória transmitida por e-mail; allowlist de redirect e domínio de links configurado.
- [ ] Testar com servidor SMTP de teste; produção depende de domínio e serviço SMTP autorizados.

## B03 — Motor de mensagens, eventos e mídia

### Task 6: Contratos, persistência e outbox de envio

**Criar:** packages/contracts/src/messages/schemas.ts; apps/api/src/modules/messages/{service,repository}.ts; rotas messages; migrations messages/message_status_events/outbox_events; testes.
**Rotas:** POST /v1/instances/:id/messages e GET /v1/messages/:id.

- [ ] RED: duas organizações, permissão, capacidade, idempotência com corpo diferente e persistência atômica mensagem/outbox.
- [ ] Implementar resposta 202 com ID JRC; separar ACCEPTED de SENT/DELIVERED/READ/FAILED/UNKNOWN.
- [ ] GREEN: rollback não publica; API não espera HTTP do provider.

### Task 7: Worker e adapter de envio Baileys

**Criar:** apps/worker/src/{main,outbox-dispatcher}.ts; packages/providers/src/messages/{contracts,evolution}.ts; workspace/exports; fixtures e testes.

- [ ] RED: claim concorrente, lease, crash/restart, timeout incerto e deduplicação; limitar concorrência por conexão.
- [ ] Implementar despacho durável com RabbitMQ e ack após registro; retry apenas para falha seguramente repetível; UNKNOWN não é reenviado cegamente.
- [ ] GREEN com processo compilado e transporte de teste; smoke autorizado texto de ponta a ponta exige destinatário de teste confirmado.

### Task 8: Entrada e status por webhooks de provider

**Criar:** apps/api/src/http/routes/provider-webhooks.ts; apps/api/src/modules/events/{inbox,normalizer}.ts; worker de inbox; migrations e testes.

- [ ] RED: autenticação inválida, tenant forjado, ID duplicado, eventos fora de ordem e instância desconhecida.
- [ ] Persistir inbox antes de ack; resolver organização por vínculo interno; normalizar IDs/estados e impedir eco.
- [ ] GREEN HTTP + PostgreSQL + replay de fixtures sanitizadas; não registrar payload bruto em logs.

### Task 9: Mídias e webhooks dos clientes

**Criar:** módulos media e webhooks na API/worker; adapters de storage privado; rotas media/webhook-endpoints/webhook-deliveries; telas e testes.

- [ ] RED: tipo/tamanho falso, URL expirada, IDOR, SSRF/DNS/redirect, assinatura e retry/DLQ.
- [ ] Implementar download/upload com stream limitado, URLs autorizadas curtas, checksum/retenção; destinos HTTPS validados e segredos rotativos.
- [ ] GREEN: arquivo real de teste atravessa provider/storage; destino indisponível não perde evento nem bloqueia outro tenant.

## B04 — Meta oficial e templates

### Task 10: Credenciais e onboarding Meta

**Criar:** módulos meta-onboarding, credential-store e rotas; substituir esqueleto packages/providers/src/meta/meta-provider-adapter.ts com implementação; tela MetaConnection; migrations e testes.

- [ ] Verificar documentação oficial atual, versão Graph suportada, ativos e permissões; registrar fixtures e versão, sem presumir elegibilidade.
- [ ] RED: state inválido/reutilizado, callback de outra organização, token sem acesso ao ativo, webhook com assinatura inválida e rotação.
- [ ] Implementar troca de código no backend, criptografia com chave estável externa, inscrição em webhook e capacidades efetivas.
- [ ] GREEN local com contratos; homologação depende de aplicativo Meta, conta/número e HTTPS aprovados. Coexistência somente quando confirmada elegibilidade.

### Task 11: Mensagens e templates Meta

**Criar:** módulos/templates, contratos/rotas e telas Templates/TemplateEditor; adapter Meta de mensagens/mídia; testes.

- [ ] RED: política/janela/capacidade, variáveis faltantes, idioma, rejeição/pausa e eventos fora de ordem.
- [ ] Implementar CRUD/submissão/sincronização com estados reais; nunca marcar aprovado por sucesso do POST de submissão.
- [ ] GREEN com fixtures; enviar template realmente aprovado para número autorizado antes de declarar homologação.

## B05 — Typebot

### Task 12: Configuração por cliente e execução conversacional

**Criar:** packages/integrations/src/typebot/{client,adapter}.ts; apps/api/src/modules/bots/{bindings,sessions}.ts; apps/worker/src/bots/typebot-runner.ts; tela Integrations; migrations/testes.

- [ ] RED: URL hostil/redirect, cross-tenant, evento duplicado, timeout/resposta perdida e dois eventos simultâneos da mesma conversa.
- [ ] Vincular bot publicado a instância, manter sessão/variáveis e fila por conversa; limitar payload; pausa humana impede resposta automática.
- [ ] GREEN E2E: mensagem recebida vira interação Typebot e resposta sai pela API JRC; testar também falha externa. Não incorporar editor sem validação de licença.

## B06 — Canvas JRC

### Task 13: Grafo canônico e publicação versionada

**Criar:** packages/contracts/src/flows/schemas.ts; apps/api/src/modules/flows/{validator,repository,publication}.ts; rotas flows; migrations/testes.

- [ ] RED: aresta inválida, nó inexistente, início múltiplo, bloco sem saída e loop sem limite.
- [ ] Implementar grafo tipado, rascunho e versão publicada imutável; versão fixada pela sessão; IDs sempre isolados por organização.
- [ ] GREEN unidade + integração de publicação concorrente/IDOR.

### Task 14: Editor e simulador

**Criar:** apps/web/src/flows/{Canvas,NodePalette,Inspector,Simulator}.tsx; páginas Flows/FlowEditor; componentes/testes.

- [ ] Escolher biblioteca de grafo com versão/licença verificadas; sem copiar editor protegido.
- [ ] RED: criar blocos/arestas, desfazer/refazer, validação antes de publicar e conflitos de edição.
- [ ] Implementar início/texto/pergunta/condição/variável/HTTP/template/humano/fim, teclado e mensagens pt-BR.
- [ ] GREEN E2E: desenhar, salvar, reabrir, simular e publicar fluxo real; simulador não envia WhatsApp.

### Task 15: Runtime do canvas

**Criar:** apps/worker/src/flows/{runner,blocks,session-repository}.ts; testes unitários e integração.

- [ ] RED: persistência de espera, retomada após restart, orçamento de passos, timeout HTTP, duplicação e isolamento.
- [ ] Executar DSL declarativa sem eval; limites por bloco/conversa; erros auditáveis e pausa humana prioritária.
- [ ] GREEN jornada: pergunta/resposta/condição/template/transferência com versão imutável.

## B07 — Atendimento

### Task 16: Inbox e transferência humano/bot

**Criar:** módulos contacts/conversations/assignments na API; rotas e contratos; apps/web/src/pages/inbox; migrations/testes.

- [ ] RED: atendente fora da equipe, IDOR, disputa de atribuição e bot enviando durante pausa humana.
- [ ] Implementar caixa de entrada, histórico, responsável, notas, estados e retomar bot; atualização limitada e autorizada.
- [ ] GREEN E2E com dois atendentes/dois clientes; mensagens do atendente passam pelo mesmo broker.

## B08 — Comercial e produção

### Task 17: Limites, consumo e faturamento

**Criar:** módulos plans/quotas/usage/subscriptions e telas administrativas; migrations/testes.

- [ ] RED: corrida no limite, evento de consumo duplicado, downgrade e cliente suspenso.
- [ ] Implementar cotas e livro de consumo idempotente; separar consumo técnico de cobrança externa.
- [ ] Adapter de pagamento somente após escolha do serviço e credenciais sandbox; webhook de cobrança assinado/idempotente. Não inventar tarifa Meta ou cobrar cliente real.

### Task 18: Operação, recuperação e auditoria final

**Modificar:** infra, CI, docs/operations; scripts/security; criar auditoria do novo incremento em docs/security/complete-broker.

- [ ] Testar backup/restore, restart de worker, DLQ, isolamento sob carga, rotação de chaves com dados existentes e retenção/exclusão.
- [ ] Métricas de fila, falha, latência e consumo sem PII; runbooks e capacidade medida, não números de SLA inventados.
- [ ] Gates: npm test; npm run typecheck; npm run test:integration; npm run build; npm run test:compiled; npm run test:e2e; npm audit --audit-level=high; Docker build/entrypoint; OpenAPI duas gerações idênticas; contratos/licenças/submódulo; auditoria generate/verify/gate; git diff --check.
- [ ] Varredura de segredos no diff, histórico JRC e bundle. Relatório com findings, strengths, inventário de rotas e PDF rasterizado/inspecionado.
- [ ] Publicação exige autorização específica, secrets CI configurados e homologação humana/Meta concluída. Até lá, registrar cada dependência pendente e não declarar o broker completo.

## Critério de encerramento

Só encerrar como concluído após executar o aceite da especificação com evidências. Marcar separadamente: implementado, teste automatizado, integração real e homologação externa. Se um serviço externo bloquear uma trilha, continuar tarefas independentes; nunca fabricar resposta operacional nem substituir provider real por fake no runtime do cliente.
