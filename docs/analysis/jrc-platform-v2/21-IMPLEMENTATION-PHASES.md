# 21 — Fases de implementação

Cada fase termina com demonstração e rollback exercitável.

| Fase | Meta e dependências | Mudanças principais | Testes/aceite | Rollback |
|---|---|---|---|---|
| 0. Baseline | inventário aprovado | ADRs, OpenAPI congelada, flags, dashboards | CI atual + diff de contrato | somente documentos/flags |
| 1. Contratos canônicos | backup e 0024/0025 confirmadas | corrigir 401/500/503; contratos channel/automation; logs correlacionados | console global e contrato sem regressão | digests/rotas atuais |
| 2. JRC managed connector | fase 1 | membership por inbox; status/pair; restrição de disconnect/replace | qualquer membro pareia; operador não substitui | grants/control legados |
| 3. Chatwoot externo | fases 1–2 | destinations, handshake e portal/embed seguro | instalação externa ponta a ponta | integração antiga |
| 4. Canais + Meta UX | fases 1–3 | fachada `/v1/channels`, QR, Meta e quatro estados | QR/Meta homologados | fachada delega ao legado |
| 5. Runtime Automation v2 | fase 1 | definitions/versions/bindings, executions, outbox e scheduler | crash/retry/idempotência/waits | runtime por flag |
| 6. Automation Studio | fase 5 | editor, catálogo, validação, diff, simulação e timeline | acessibilidade + publicação | canvas antigo |
| 7. Integrações genéricas | fases 4–6 | cofre, HTTP, webhook, JSON, SQL, sandbox, IA, subflow | SSRF/sandbox/RBAC e contratos | flags por nó |
| 8. Observabilidade | fases 4–7 | explorer, health por camada, UNKNOWN e alertas | falha rastreável por correlação | dashboards anteriores |
| 9. Migração do legado | fases 5–8 | converter flows JRC/Broker, dupla leitura e owner único | reconciliação e uso legado zero | runtime antigo por binding |
| 10. Hardening de produção | estabilidade medida | restore drill, escala, SLO, redirects e retirada posterior | carga, segurança e rollback ensaiado | release anterior compatível |

## Arquivos e módulos por onda

- API: `apps/api/src` em serviços `channels`, `automations`, `credentials`, `destinations`, `events` e `outbox`.
- Worker: separar consumidores de mensagem, automação, I/O e agendamento a partir do worker atual.
- Web: consolidar rotas em `channels`, `automations`, `executions` e `destinations`.
- Banco: novas migrations após 0025, sempre aditivas até a fase 10.
- JRC Conversas: controlador/cliente Broker, memberships de inbox e UI de pareamento; o motor local fica compatível até a migração.

## Entregas verificáveis por fase

| Fase | Migração esperada | API/UI | Evidência de aceite |
|---|---|---|---|
| 0 | nenhuma | nenhuma mudança de runtime | inventários, ADRs e contratos versionados |
| 1 | somente correção aditiva se divergência for comprovada | erros estáveis e health de schema | smoke tests 401/403/500 + console super admin |
| 2 | binding/grant por inbox, aditivo | control API e tela JRC de estados | teste Rails membership + contract test Broker |
| 3 | destinations/authorizations, aditivo | setup admin e portal/embed | handshake, origem, token expirado e SSRF |
| 4 | channel facade/mapeamentos, aditivo | `/v1/channels` e assistente Meta/QR | fixtures Meta/Evolution e E2E sem provider real no CI |
| 5 | entidades Automation v2/outbox/waits | `/v1/automations`, `/v1/executions` | crash recovery, ordering, UNKNOWN, cancel/resume/retry |
| 6 | preferências/layout se necessário | Studio e Execution Explorer | editar/validar/simular/publicar por teclado e mouse |
| 7 | credentials/hooks/schedules | catálogo e inspetores tipados | vault, SSRF, SQL read-only, sandbox e AI tools |
| 8 | retenção/índices conforme medição | Health Center e timeline | alertas e trace da entrada ao efeito |
| 9 | backfill/compatibilidade, nunca remoção imediata | redirects e import reports | checksum, owner único e execuções em curso preservadas |
| 10 | remoção somente em release posterior | corte de flags antigas | carga, pentest, restore e rollback com digests |

## Primeiro incremento executável

A fase 1 deve ser o próximo PR: diagnóstico reproduzível dos 500/503, verificação automática das migrations, respostas de erro com correlação e smoke tests do super admin e Chatwoot. Ela reduz risco antes de ampliar o produto.
