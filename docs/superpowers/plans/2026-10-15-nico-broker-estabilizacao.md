# NICO e Broker — plano de implementação da estabilização

> **For agentic workers:** Usar superpowers:executing-plans para executar as tarefas nesta sessão. Cada etapa registra RED, GREEN, revisão e resultado. Não repetir tarefas concluídas no ledger.

**Goal:** Corrigir o contexto recente do NICO e a exibição de autoridade do atendimento antes da coordenação distribuída e da entrega dos módulos.
**Architecture:** O NICO continua executando ferramentas autorizadas no JRC; o Broker mantém o motor e o controle do chatbot. Corrigir os caminhos existentes sem alterar produção ou reativar bots.
**Tech Stack:** Ruby/Rails/ActiveRecord/RSpec no JRC; Node 24.19.0, TypeScript, React, Vitest e Playwright no Broker.
**Spec:** [Desenho aprovado em 15/10](../specs/2026-10-15-nico-broker-coordenado-design.md). Programa: [P0–P10](2026-10-05-broker-programa-integracao.md).

## Global Constraints

- Branch de homologação em ambos os repositórios: codex/nico-broker-coordenado-20261015.
- Bases: Broker 0620ecd0c03ec22252f8518d3a76b6414f6d6cf0; JRC b58e093dd3a32fe97829a4566660b83ee48b9eca.
- A autorização de branch separada de 15/10 substitui a regra anterior de integrar diretamente na main para este candidato.
- Preservar os digests e o atendimento existentes no servidor. Publicação de candidato não é deploy.
- Nenhum payload de cliente, segredo ou telefone em fonte, testes ou commits.
- Leituras NICO preservam autorização, Account e filtros público/privado existentes.
- Controles de humano/bot afetam somente a conversa selecionada; retomada exige ação explícita.
- Resultado externo incerto requer reconciliação antes de repetição.
- Não ativar NICO delegado em paralelo com o bot Broker.

## Review Focus

1. Mais de 30 mensagens e horários empatados: janela recente determinística, exibida cronologicamente.
2. Mensagens privadas e outra Account: nunca entram no contexto público da conversa consultada.
3. Mudança de tenant/conversa com GET em andamento: resposta tardia não atualiza o atendimento errado.
4. Atualizar histórico não pode reenviar mensagens, retomar bot ou descartar rascunho.
5. Candidato JRC/Rails e Broker com revisões distintas: manifesto deve identificar cada componente e nenhuma tag de produção pode ser movida pelo build de teste.

## Task 1: Histórico recente NICO

**Files (repositório jrc-conversas-lab2):**
- Modify: app/services/jrc_nico/operator_session.rb
- Modify: app/services/jrc_nico/tool_executor.rb
- Modify: app/jobs/jrc_nico/customer_turn_job.rb
- Modify: app/services/jrc_nico/context_builder.rb
- Test: spec/services/jrc_nico/recent_history_spec.rb

**Interfaces:**
- Consumes: conversation.messages com default_scope de Message por created_at ascendente.
- Produces: public_history, conversation_sample_messages, read_conversation e customer_context conservam seus formatos e limites, selecionando as mensagens recentes da conversa correta.

- [ ] Escrever regressões com mensagens antigas suficientes para exceder 5/30/40; uma mensagem pública recente identificável; mensagens privadas e outra conversa/Account.
- [ ] Executar os testes no código original e registrar falhas na seleção da janela.
- [ ] Substituir a ordenação acumulada por reorder(id: :desc) somente nas leituras Message afetadas; manter filtros, limites e reversão cronológica.
- [ ] Testar a seleção mais recente de incoming_scope no CustomerTurnJob; preservar a estratégia de coalescer entradas na última mensagem e impedir bloqueio por turno antigo superseded.
- [ ] Executar regressões e testes NICO existentes pertinentes; confirmar que não há dependência Enterprise conflitante.
- [ ] Commit focado na branch de homologação com registro de versão e testes.

## Task 2: Estado atual da conversa no Broker

**Files (repositório BrokerJRCIA):**
- Modify: apps/web/src/pages/Messaging.tsx
- Test: apps/web/src/pages/Messaging.test.tsx

**Interfaces:**
- Consumes: GET /v1/messaging/conversations/:id e GET /v1/messaging/conversations/:id/messages.
- Produces: o botão Atualizar histórico atualiza mensagens e o modo da conversa selecionada, sem mutações de atendimento.

- [ ] Escrever teste BOT → HUMAN remoto: clicar Atualizar histórico deve mudar o rótulo e a ação disponível.
- [ ] Escrever teste de navegação/tenant durante consulta pendente e preservação de rascunho.
- [ ] Rodar o arquivo antes da implementação e verificar falha de estado obsoleto.
- [ ] Carregar o estado da conversa junto ao histórico com os mesmos guards de aborto/tenant/navegação; não limpar o rascunho nem retomar bot.
- [ ] Executar testes Messaging e typecheck; executar npm test e git diff --check antes do commit exigido pelo AGENTS.
- [ ] Commit focado na branch de homologação.

## Task 3: Release candidata e acompanhamento do programa

**Files:**
- Modify: docs/superpowers/plans/2026-10-05-broker-programa-integracao.md (nota de política do candidato)
- Create: docs/validation/2026-10-15-nico-broker-candidato.md
- Inspect: .github/workflows/images.yml no Broker e .github/workflows/build-ghcr.yml no JRC

**Interfaces:**
- Consumes: commits verificados das tarefas 1/2.
- Produces: SHA/CI por repositório e digests somente quando houver build confirmado; procedimento de instalação futura sem executar deploy.

- [ ] Revisar a branch e os testes; preservar toda limitação encontrada no relatório.
- [ ] Publicar branches autorizadas sem alterar main/default branch.
- [ ] Garantir tags de candidato identificadas pelo SHA; adaptar workflow se ele mover tags de produção durante um build de branch.
- [ ] Executar o CI correspondente, corrigindo falhas reais sem desligar gates.
- [ ] Gerar imagens candidatas dos componentes alterados e verificar manifestos/labels.
- [ ] Registrar o que o operador precisará configurar no Dokploy para homologação separada.

## Continuidade do programa

A estabilização é o primeiro incremento, não o programa completo. Executar em seguida a coordenação de tomada NICO/Broker, as cinco ações e timeout do Flow, composição QR/Flow/ownership para o JRC atual, ampliação das ferramentas NICO, perfis multitenant/externo e as provas específicas de canais/capacidade, conforme a recomendação aprovada e P0–P10. Interfaces novas recebem especificação e testes antes da implementação.

Informações externas necessárias na homologação: ambiente isolado/domínio para imagens candidatas; Account/caixa A e B; instalação externa de teste; ativos Meta quando disponíveis; endpoints/capacidade/credenciais do storage configurados diretamente no ambiente. Esses dados não são necessários para iniciar os testes sintéticos de código.

