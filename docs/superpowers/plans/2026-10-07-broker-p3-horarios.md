# Broker P3 — horários determinísticos

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax. A integração ao runtime e a revisão final pertencem ao agente principal.

**Goal:** Entregar contrato, avaliador puro e formulário de horários para integração ao Flow existente.
**Architecture:** Zod valida a configuração compartilhada. `isBusinessOpen(config, now)` usa o instante recebido e `Intl` para decidir os intervalos no fuso configurado; uma exceção substitui a semana naquele dia. O editor preserva campos desconhecidos e rascunhos inválidos para correção.
**Tech Stack:** TypeScript, Zod, Intl, React, Vitest e Testing Library existentes; nenhuma dependência nova.
**Spec:** [P3 aprovado](../specs/2026-10-05-broker-independente-centrais-design.md), seção Flow funcional; R6/U3b nos planos de runtime e Studio.

## Restrições globais

- Criar somente os seis arquivos de contrato/avaliador/editor e respectivos testes, este plano e ledger.
- Não editar engine, types, node-definitions, FlowCanvas, index, Studio ou OpenAPI; o agente principal integra.
- Nenhum commit, push, suíte completa, banco, rede ou produção neste corte.
- `weekly`: 1–28 intervalos com domingo=0 até sábado=6; início HH:mm, fim HH:mm ou 24:00; início estritamente anterior ao fim.
- `exceptions`: opcional, até 366 datas calendárias YYYY-MM-DD únicas; cada data tem 0–4 intervalos. Lista vazia fecha o dia.
- Não há intervalo atravessando meia-noite implicitamente; configurar linhas em dias distintos.
- Início inclusivo e fim exclusivo; `now` e configuração inválidos produzem erro explícito.
- Este corte não habilita Flow sozinho e não conclui P3.

## Foco da revisão

- Domingo e virada do dia no fuso configurado, independente do fuso da máquina.
- Horário de verão com hora repetida ou inexistente: decidir pelo horário civil efetivo de cada instante.
- 24:00 apenas como fim e datas bissextas reais, sem normalização silenciosa.
- Exceção fechada ou com intervalos próprios substitui integralmente a semana daquele dia.
- Editor com campo importado inválido permanece corrigível e preserva metadados desconhecidos.

## Tarefa 1 — contrato

Criar `packages/contracts/src/automation-schedule.ts` e `packages/contracts/tests/automation-schedule.test.ts`.
Produzir `ScheduleNodeConfigSchema` e `ScheduleNodeConfig` com os campos acima.

- [x] Escrever assertions de configuração válida e rejeições: fuso, formato/ordem, limites, data bissexta e duplicada; conferir paths dos diagnósticos.
- [x] RED: teste de contrato executado junto aos outros dois arquivos focados.
- [x] Implementar Zod e validações de fuso/data/intervalos.
- [x] GREEN: repetir os três arquivos e registrar resultado no ledger.

## Tarefa 2 — avaliador

Criar `apps/api/src/modules/automations/business-hours.ts` e `apps/api/tests/unit/business-hours.test.ts`.
Produzir `isBusinessOpen(config: ScheduleNodeConfig, now: Date): boolean`. Consumir o contrato por import relativo até integração global.

- [x] Escrever assertions de bordas, domingo, virada UTC/fuso, exceções, 24:00, DST e erros de config/fuso/clock.
- [x] RED: teste do avaliador executado junto aos outros dois arquivos focados.
- [x] Validar entrada antes de usar Intl; comparar minutos civis no fuso; usar data local para a exceção.
- [x] GREEN: repetir os três arquivos e registrar resultado no ledger.

## Tarefa 3 — formulário

Criar `apps/web/src/automations/node-editors/ScheduleEditor.tsx` e `ScheduleEditor.test.tsx`.
Produzir `ScheduleEditor({data,onChange,editable})`; campos de fuso, semana e exceções com adicionar/remover e dias em português, sem JSON.

- [x] Escrever assertions de edição controlada, campos extras preservados, feriado/exceção, diagnósticos e permissão de leitura.
- [x] RED: teste do formulário executado junto aos outros dois arquivos focados.
- [x] Implementar formulário com validação Zod por path e aria-invalid/descrição de campo.
- [x] GREEN: repetir os três arquivos e registrar resultado no ledger.

## Entrega ao agente principal

- [x] Rodar juntos somente os três arquivos focados, revisar código novo e reportar resultados.
- [x] Documentar import/export global e ligação de schedule ao catálogo, engine, simulador e Canvas ainda necessários.
- [x] Não habilitar paleta; esses pontos e testes de integração pertencem ao agente principal.
