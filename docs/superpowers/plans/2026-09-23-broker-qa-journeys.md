# Correções de QA das jornadas do Broker JRC

> Execução: superpowers:executing-plans, nesta sessão. Complemento do plano aprovado, marcos 3, 4 e UX; as capturas de 23/09 são evidências de defeitos, não especificação de outro runtime.

**Objetivo:** permitir operar caixas WhatsApp, automações próprias e atendimento sem configuração de motores externos na interface do cliente.

**Arquitetura:** manter APIs e dados existentes; usar o Automation Runtime JRC como jornada principal. Rascunhos podem conter blocos incompletos; publicação e execução continuam exigindo validação. Desativação/desvinculação preservam histórico e são diferentes de apagar dados.

**Stack:** TypeScript, React, Fastify, PostgreSQL/RLS, Vitest e Playwright.

**Spec:** `docs/superpowers/specs/2026-09-22-jrc-platform-v2-completion-design.md`.

## Restrições

- Segredos, dados reais e instalações de clientes não entram em fixtures nem commits.
- Nenhuma exclusão, desconexão ou envio real será executado durante QA.
- Não substituir os motores internos por Typebot/n8n; remover sua configuração das telas comerciais.
- Conservar isolamento tenant, permissões OWNER/ADMIN e suporte administrativo auditado.
- Diferenciar validação local de homologação real de WhatsApp, Meta e central de atendimento.

## Revisão obrigatória

- JSON com coordenadas negativas ou muito distantes deve ficar visível no editor.
- JSON parcialmente compatível deve poder ser salvo, sem ser publicado ou executado como se fosse compatível.
- Troca de organização não pode manter cartões ou respostas assíncronas da anterior.
- Desvinculação deve parar roteamento sem apagar mensagens ou caixa remota silenciosamente.
- Ausência de aplicativo Meta ou módulo no sistema de atendimento deve ser uma pendência explícita, sem anunciar integração concluída.

## 1. Automações

- [x] Criar regressões em `apps/api/tests/unit/automation-drafts.test.ts` para salvar grafo incompleto e recusar publicação/simulação.
- [x] Corrigir `modules/automations/service.ts`, mantendo a validação estrutural do contrato em create/save e a semântica em publish/simulate.
- [x] Detectar formato JSON na importação; adicionar testes do artefato JRC e dos formatos externos suportados, sem pedir ao cliente para escolher um motor.
- [x] Corrigir `FlowCanvas.tsx`: origem visual independente das coordenadas; visão geral enquadra os blocos; seleção acessível continua funcional.
- [x] Unificar navegação em `/automations`; preservar acesso aos dados anteriores por migração explícita.
- [x] Acrescentar exportação, cancelamento de edição e orientação para ativar em uma caixa; traduzir as saídas do simulador.

## 2. Caixas e atendimento

- [x] Revisar `channels/facade.ts`, contratos e telas para apresentar identidade e vínculo da caixa, estado WhatsApp e automação real.
- [x] Corrigir status da automação usando binding ativo/pausado; respeitar organização em todas as consultas.
- [x] Expor QR temporário com expiração, andamento e atualização de status; não exibir “conectado” quando apenas provisionado.
- [x] Permitir pausar/desvincular automação e atendimento por ações explícitas e protegidas.
- [x] Remover configuração externa em `Messaging.tsx`; mostrar templates somente em canais oficiais.

## 3. Ciclo de vida e administração

- [x] Mapear ações existentes, dependências e restrições antes de acrescentar excluir/arquivar.
- [x] Implementar ações seguras para desfazer cadastros e vínculos, com confirmação clara, permissão e testes negativos.
- [x] Expor ações por empresa/usuário no painel JRC, usando a fronteira administrativa auditada existente.
- [x] Verificar cancelamento de formulários, prevenção de clique duplicado e erros acionáveis.

## 4. Evidências e módulos JRC Conversas/Chatwoot

- [x] Registrar matriz de QA por tela, defeitos corrigidos e limites restantes.
- [x] Documentar jornada QR → caixa → automação → atendimento humano com URLs e permissões existentes.
- [x] Documentar dois módulos no host: conectar WhatsApp e editar/ativar automações do Broker; distinguir integração API disponível de código ainda necessário no host.
- [x] Executar testes focados, typecheck/build, suíte completa, contratos e E2E aplicáveis; registrar resultados reais.
- [x] Revisar diff e entregar mudanças verificáveis. Publicação/deploy são etapas separadas.

## Fechamento

Implementação e revisão local concluídas em 23/09/2026. Relatório: `docs/qa/2026-09-23-broker-journeys.md`. Guia dos módulos: `docs/integrations/jrc-conversas-modulos-broker.md`.

Decisão de ciclo de vida: arquivar/desativar cadastros com histórico; excluir fisicamente apenas vínculos de atendimento sem referências. Código do host, adaptação do JSON real de 62 blocos e homologação com provedores reais são pendências explicitadas, não entregas declaradas.

Verificação: 1.232 testes da suíte principal, 266 de integração PostgreSQL, 29 E2E aprovados e 5 casos ignorados por plataforma; 2 testes compilados passaram com banco/Redis isolados. Build, contratos, bundle, licenças, scanner de 182 rotas e diff sem erros.
