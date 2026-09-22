# JRC Platform V2 — programa de conclusão

**Spec:** `docs/superpowers/specs/2026-09-22-jrc-platform-v2-completion-design.md`

## Objetivo

Entregar as fases 9 e 10 e os módulos faltantes em incrementos verdes. Cada plano abaixo produz software executável, migrations aditivas, documentação e evidência de validação.

## Ordem dos planos

1. **Fase 9 — consolidação e migração legada**
   - Plano: `docs/superpowers/plans/2026-09-22-phase-9-legacy-migration.md`
   - Saída: snapshot consolidado, migration 0029 validada, owner único, cutover/rollback, OpenAPI e suíte verdes.
2. **Segurança multitenant e justiça operacional**
   - MFA obrigatório em produção, suspensão uniforme, API keys, fairness e fronteira Evolution.
3. **Canais completos**
   - Meta templates/mídia/revogação/reconciliação; Baileys pairing/reconnect/identity.
4. **Automation Studio JRC e conectores**
   - importação Typebot/n8n, catálogo próprio de nós e conectores OpenAI/Dify/Flowise/HTTP.
5. **Atendimento e campanhas**
   - contatos, inbox, handoff, campanhas, segmentos, agenda, relatórios e limites.
6. **UX dos portais**
   - portal tenant e administração JRC completos, responsivos, acessíveis e sem formulários JSON improvisados.
7. **Fase 10 — hardening e release**
   - restore drill, carga, healthchecks, supply chain, GHCR, promoção por digest e runbook Dokploy.

## Portões globais

Nenhum plano posterior altera migrations ou contratos de um plano anterior sem teste de upgrade. Nenhuma homologação externa usa credenciais reais sem configuração fornecida para o ambiente apropriado. Nenhuma imagem recebe tag de release com testes, restore ou manifestos divergentes.

## Critério de conclusão do programa

Todos os critérios da spec estão comprovados por testes automatizados ou por evidência de homologação explicitamente identificada. Código implementado, teste local, teste em homologação e operação externa são sempre reportados separadamente.
