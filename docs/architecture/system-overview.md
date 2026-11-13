<!-- jrc-operational-init:v1 -->
# Visão do sistema — Broker JRC

## Propósito e fronteira

SaaS independente e multiempresa de conectividade WhatsApp, eventos, mensagens, mídia, automações e integrações.

**Stack:** TypeScript, Node.js, Fastify, React/Vite, PostgreSQL, Redis, Evolution/Baileys e armazenamento compatível com S3.

**Natureza:** Brownfield. **Tipo de raiz:** application.

## Fluxo lógico

Consumidor autorizado → API Broker → PostgreSQL/journal/outbox → worker → Evolution ou Meta; eventos retornam ao adaptador autorizado.

Esta é uma visão de responsabilidades baseada em fontes locais, não um levantamento dos hosts efetivos. Versão em execução, topologia física, portas produtivas e imagem implantada não foram verificadas neste bootstrap.

## Controle de versões

- Data da leitura: 2026-11-13.
- Branch local: `codex/whatsapp-history-sync-20261111`.
- HEAD de origem antes da documentação: `f8e730efd7435d77232f6c6a58a64c91ff00859b`.
- Origem Git: `https://github.com/ClaudioHideki/BrokerJRCIA.git`.
- [Contexto e versões declaradas](repository-context-init-v1.json).

Esse HEAD é a base documental observada e não será atualizado para fingir versão produtiva. A revisão documental, o software, o commit, a imagem publicada e a imagem em execução são informações distintas.

## Fontes atuais

- [AGENTS.md](<../../AGENTS.md>)
- [README.md](<../../README.md>)
- [CONTINUE-AQUI.md](<../../CONTINUE-AQUI.md>)
- [package.json](<../../package.json>)
- [apps/api/src/modules](<../../apps/api/src/modules>)
- [apps/web/src](<../../apps/web/src>)
- [infra/dokploy/compose.yaml](<../../infra/dokploy/compose.yaml>)
- [docs/implementation/history-operational-host-20261112.md](<../../docs/implementation/history-operational-host-20261112.md>)

## Pendências conhecidas

- Homologar ownership, captura live/histórica e custódia sem ativar produção por inferência.
- Conferir CI, imagens e runtime separadamente; não fazer replay cego de UNKNOWN.

O padrão de arquitetura JRC completo usa prancha integrada, fluxos, runtimes e quadro de versões com fontes; a referência visual aprovada é a arquitetura R03/R04 de 13/11/2026. Este índice não substitui aquelas pranchas nem os planos existentes.
