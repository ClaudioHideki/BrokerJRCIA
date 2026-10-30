# Excluir conexões nos cartões de caixas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que administradores excluam uma conexão pelo cartão da caixa, com uma confirmação simples e acompanhamento verificável.

**Architecture:** Reutilizar `ChannelDeletion` e as rotas lifecycle existentes nos painéis da empresa e da plataforma. A confirmação envia o nome recebido da prévia autenticada e um motivo fixo auditável; a UI só atualiza a lista após `COMPLETED` e consulta operações incertas sem repetir a exclusão.

**Tech Stack:** React, TypeScript, Vitest, Testing Library; contrato HTTP lifecycle existente.

**Spec:** Demanda explícita encaminhada pelo implementador principal em 2026-10-23: botão por caixa, OWNER/ADMIN, confirmação sem digitar nome/motivo, isolamento de tenant, sem exclusão real durante desenvolvimento.

## Design breve e alternativas

- Escolhido: reutilizar o lifecycle durável já existente. Acrescentar somente o ponto de entrada nos cartões e simplificar a confirmação conserva autorização, prévia, bloqueios e auditoria.
- Rejeitado: enviar DELETE direto à Evolution; ignoraria dados locais e a proteção de resultados incertos.
- Rejeitado: recriar um segundo fluxo de exclusão no cartão; duplicaria estado e poderia repetir operações.
- Impacto exposto antes da confirmação: exclusão da sessão Evolution (QR), conversas/mensagens/configuração exclusivas no Broker, vínculos locais e mídia privada conforme lifecycle. Caixa/conversas/histórico externos Chatwoot e WABA/ativos empresariais Meta são preservados. Automações reutilizáveis não são prometidas como excluídas.
- Limite atual: o lifecycle resolve QR e META. Conexões CENTRAL são administradas na central e continuam sem botão de exclusão irreversível até existir contrato revisado para esse tipo.
- Resultado incerto de POST: bloquear nova submissão e oferecer somente consulta. Ausência de operação numa consulta isolada não prova que o POST anterior foi rejeitado.

## Global Constraints

- Nenhuma exclusão real, alteração de produção, commit, push ou deploy neste escopo.
- Não alterar rotas, SQL ou worker lifecycle; não relaxar bloqueios UNKNOWN/em andamento.
- Excluir apenas para OWNER/ADMIN do tenant e SUPER_ADMIN no painel global, com autorização do servidor preservada.
- Usar a prévia do servidor para o nome de confirmação; não confiar no nome desatualizado do cartão.
- A troca de tenant/caixa invalida respostas e callbacks anteriores; nenhuma resposta antiga aciona recarga em outro tenant.

## Review Focus

- Duplo clique e resposta perdida: no máximo um POST até existir resultado comprovado.
- ACTION_REQUIRED sem errorCode ainda carregado: não liberar retentativa antes da consulta de status.
- Troca de tenant durante prévia ou POST: ignorar resultados/callbacks antigos.
- Mesma caixa em painéis tenant/plataforma: conservar os prefixos de rota de cada chamador.
- Operador/leitor e CENTRAL: não expor controle sem suporte/autorização.

### Task 1: Confirmação simples e recuperação segura

**Files:** `apps/web/src/channels/ChannelDeletion.tsx`, `apps/web/src/channels/ChannelDeletion.test.tsx`.

**Interfaces:** Preservar `request`, `path`, `disabled`, `onCompleted`; aceitar `scopeKey` opcional para invalidar a operação quando o contexto muda sem alterar o path.

- [x] Escrever RED para confirmação sem campos, motivo fixo, prévia/bloqueios, recuperação existente, resposta perdida, duplo clique e resultados tardios.
- [x] Executar o arquivo focal e observar falhas funcionais antes de editar a implementação.
- [x] Implementar o formulário simples, trava de solicitação incerta e callback somente para conclusão comprovada.
- [x] Executar GREEN focal.

### Task 2: Acesso nos cartões e regressão dos dois painéis

**Files:** `apps/web/src/pages/Channels.tsx`, `apps/web/src/pages/Channels.test.tsx`; `apps/web/src/platform/CompanyChannels.tsx`/testes somente onde necessário.

**Interfaces:** Tenant usa `/v1/channels/:id`; plataforma mantém `/:id` relativo ao request da empresa selecionada. `onCompleted` recarrega a lista corrente.

- [x] Escrever RED para botões OWNER/ADMIN em QR/META, ausência OPERATOR/VIEWER/CENTRAL, POST correto e recarga após COMPLETED.
- [x] Implementar integração reutilizando o componente e a chave de contexto do tenant.
- [x] Validar plataforma, cancelamento e pós-conclusão, sem mocks de sucesso que antecipem o worker.
- [x] Executar suites focais, typecheck e `git diff --check`; combinar com o implementador principal um novo gate completo sobre a fonte estabilizada.

## Verificação

`npm.cmd test -- apps/web/src/channels/ChannelDeletion.test.tsx apps/web/src/pages/Channels.test.tsx apps/web/src/platform/CompanyChannels.test.tsx --maxWorkers=1`

`npm.cmd run typecheck`

`git diff --check`

## Evidência local

- RED inicial: 2 arquivos, 8 falhas funcionais e 6 passes, antes da implementação (10:16).
- GREEN após integração: 5 arquivos/33 testes (incluindo os testes antigos de detalhe).
- RED adicional: rejeição HTTP409 ficava indevidamente presa como resultado incerto; focal falhou antes da correção.
- GREEN final do escopo de exclusão: 4 arquivos/26 testes, 0 falhas (10:28); inclui rota relativa de plataforma, troca de empresa, dupla submissão e resposta perdida.
- Typecheck e `git diff --check` passaram. O gate integral deve executar após estabilização das mudanças paralelas do detalhe da caixa.
- Nenhuma exclusão real, publicação, commit ou deploy executado.
