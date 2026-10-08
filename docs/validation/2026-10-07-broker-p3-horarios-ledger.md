# Ledger — Broker P3 horários

- Plano escrito antes do código: `docs/superpowers/plans/2026-10-07-broker-p3-horarios.md`.
- Escopo técnico fornecido pelo agente principal, derivado do P3/R6/U3b aprovado.
- A autorização delimita testes focados; suíte completa, commit, rede e banco ficam com o agente principal.
- Integração em arquivos compartilhados é responsabilidade do agente principal.
- Primeiro comando focado bloqueado por leitura do esbuild na sandbox; rerun escalado carregou Vitest.
- Primeiro RED: os três módulos novos ainda não existiam (falha de carregamento esperada). Criado esqueleto mínimo para observar também as assertions de comportamento antes da implementação.
- RED de comportamento observado: 45 testes, 38 falhas e 7 passes com esqueleto mínimo. Configurações inválidas foram aceitas; aberturas corretas retornaram false; formulário não tinha campos.
- Implementados contrato Zod, avaliador por Intl e formulário preservando dados extras.
- GREEN confirmado: `npm test -- packages/contracts/tests/automation-schedule.test.ts apps/api/tests/unit/business-hours.test.ts apps/web/src/automations/node-editors/ScheduleEditor.test.tsx` — 3 arquivos e 45/45 testes aprovados, exit 0, duração 17,15 s (16:21:26 local em 07/10/2026).
- Cobertura: bordas inclusiva/exclusiva, domingo, vários intervalos, data local diferente de UTC, fechamento/alteração por exceção, leapdate, ambas ocorrências na volta do DST, salto do DST, relógio/config/fuso inválidos, formulário e permissões, limites e metadados preservados.
- Limite de calendário explícito: exceções usam anos de 0001 a 9999, seguindo AAAA-MM-DD; nenhuma normalização silenciosa de datas.
- Nenhum arquivo compartilhado do catálogo/engine/UI foi modificado pelo implementador deste corte. Importações relativas são temporárias, conforme instrução do agente principal.
- Nenhuma suíte completa, typecheck global, banco, rede, commit, push ou implantação executados neste corte. O agente principal executará verificação integrada.
- Entrega técnica isolada concluída; integração de catálogo/engine/simulador/Canvas e prova operacional permanecem com o agente principal. Isto não encerra P3.
