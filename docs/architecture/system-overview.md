<!-- jrc-operational-init:v1 -->
# Visão do sistema — Broker JRC — Flow por caixa LAB

## Propósito e fronteira

Frente local de Flow reutilizável por caixa, preservando os contratos do Broker e a base oficial mais recente.

**Stack:** TypeScript, Fastify, React, PostgreSQL, Redis e Evolution/Baileys.

**Natureza:** Brownfield. **Tipo de raiz:** application.

## Fluxo lógico

Consumidor autorizado → API Broker → PostgreSQL/journal/outbox → worker → Evolution ou Meta; eventos retornam ao adaptador autorizado.

Esta é uma visão de responsabilidades baseada em fontes locais, não um levantamento dos hosts efetivos. Versão em execução, topologia física, portas produtivas e imagem implantada não foram verificadas neste bootstrap.

## Controle de versões

- Data da leitura: 2026-11-13.
- Branch local: `codex/flow-por-caixa-20261109`.
- HEAD de origem antes da documentação: `dd34c7f05c41f8ced49cebf0bb6a56743ff99fbf`.
- Origem Git: `https://github.com/ClaudioHideki/BrokerJRCIA.git`.
- [Contexto e versões declaradas](repository-context-init-v1.json).

Esse HEAD é a base documental observada e não será atualizado para fingir versão produtiva. A revisão documental, o software, o commit, a imagem publicada e a imagem em execução são informações distintas.

## Fontes atuais

- [AGENTS.md](<../../AGENTS.md>)
- [README.md](<../../README.md>)
- [CONTINUE-AQUI.md](<../../CONTINUE-AQUI.md>)
- [package.json](<../../package.json>)
- [apps/api/src/modules](<../../apps/api/src/modules>)

## Pendências conhecidas

- Conferir equivalência e ancestralidade antes de consolidar esta frente no Broker atual.
- Homologar instâncias Flow e roteamento por caixa com tenants isolados.

O padrão de arquitetura JRC completo usa prancha integrada, fluxos, runtimes e quadro de versões com fontes; a referência visual aprovada é a arquitetura R03/R04 de 13/11/2026. Este índice não substitui aquelas pranchas nem os planos existentes.
