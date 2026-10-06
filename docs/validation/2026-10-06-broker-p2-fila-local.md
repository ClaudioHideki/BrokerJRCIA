# P2 A — Fila humana local no Broker

Incremento desenvolvido sobre main 1c6e49a, na branch codex/broker-p2-modes-catalog-20261005. Não encerra P2 B–E nem as demais fases do [programa](../superpowers/plans/2026-10-05-broker-programa-integracao.md).

## Comportamento implementado

- Destino LOCAL V2 com organização/canal UUID e fila manual, sem Account/Inbox fictícios. Contrato remoto V1 preservado.
- Catálogo de canais locais, protegido por membership atual OWNER/ADMIN e RLS, sem cache; editor distingue explicitamente destino local e central.
- Publicação, vínculo e execução revalidam canal ativo e ausência de conexão/autoridade central. Central FAILED/DISABLED não vira atendimento local.
- Transferência interrompe bot, registra WAITING_HUMAN e recibo local na mesma transação. Enfileiramento da mensagem anterior não basta: exige entrega registrada.
- Reserva local expirada pode ser recuperada sem runtime Chatwoot; lease corrente e ordem são revalidadas. UNKNOWN remoto nunca é repetido por esse mecanismo. Mudança para humano encerra apenas a reserva pendente, preservando a conversa.
- Diagnóstico distingue LOCAL antes do recibo, inclusive em PENDING, FAILED e UNKNOWN. Publicação/vínculo/arquivamento e admissão de conexão central usam locks compatíveis.

## Verificação em 06/10/2026

| Verificação | Resultado observado |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run build`, `npm run test:web:bundle` e `git diff --check` | PASS; 11 arquivos de bundle, nenhum achado |
| `npm test -- --maxWorkers=2` | 266 arquivos, 1.746 testes PASS; 558,23 s |
| standalone-handoff, attendance-archive-concurrency e attendance-ownership-concurrency | 21 testes PASS com PostgreSQL e Redis descartáveis |
| Regressão anterior: onboarding/tenants/archive/ownership/resume e jornada local | 31 testes PASS; anterior aos últimos ajustes de revisão, complementada pelas três suítes acima |
| Diagnósticos UI e inventário de segurança | 59 testes PASS; incluídos também na suíte completa acima |
| Revisão independente dos três achados | Nenhum bloqueio restante; recuperação, diagnóstico e serialização corrigidos |

TDD incluiu falhas antes das correções: perda de reserva após queda, diagnóstico local tratado como central e deadlock SQLSTATE 40P01 em publicação/arquivamento. Um teste adicional demonstrou reserva órfã após tomada humana e foi corrigido sem alterar o estado humano.

A jornada integrada usou banco e engine reais, com transporte sintético identificado: menu → captura → fila local → resposta de operador → retomada pelo menu. Não é prova de WhatsApp real nem de integração remota. Não houve nova execução da suíte E2E completa local, conforme recusa anterior do usuário; o CI da main anterior não cobre este incremento.

## Pendências explícitas

Times/agentes locais e atribuição manual (B), modos e onboarding (C), transporte central/revogação (D) e homologação externa (E). Não foi feita implantação no servidor. Os perfis externos serão configurados ao final conforme [preparação de homologação](2026-10-06-broker-preparacao-homologacao.md).
