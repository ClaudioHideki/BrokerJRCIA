# JRC WhatsApp Broker contributor rules

- Read the approved design and the current phase plan before editing.
- Use TDD for every feature and bug fix.
- Never commit secrets, customer payloads, telephone numbers, or Baileys auth state.
- Preserve all third-party licenses and attributions.
- Do not deploy to production without an explicit approved release task.
- Run `npm test` and review `git diff --check` before every commit.

<!-- jrc-operational-init:v1 -->
## Segundo Cérebro e Governança Operacional

- **Projeto:** Broker JRC — Flow por caixa LAB.
- **Descrição:** Frente local de Flow reutilizável por caixa, preservando os contratos do Broker e a base oficial mais recente.
- **Stack principal:** TypeScript, Fastify, React, PostgreSQL, Redis e Evolution/Baileys.
- **Natureza:** Brownfield; preservar fontes, histórico e regras anteriores.
- **Tipo desta raiz:** application.

### Leitura e manutenção do contexto

1. Leia as instruções específicas anteriores deste arquivo e o checkpoint/README do checkout real.
2. Consulte [ROADMAP.md](ROADMAP.md), [TASKS.md](TASKS.md) e [a regra operacional](.agents/rules/operational-governance.md).
3. Consulte [domínio](docs/domain/glossary.md), [regras de negócio](docs/domain/business-rules.md), [personas](docs/domain/personas.md), [arquitetura](docs/architecture/system-overview.md) e [modelo de dados](docs/architecture/data-model.md).
4. Registre uma mudança relevante de decisão em [ADR](docs/adr/README.md); não reescreva a história de uma decisão já aceita.
5. Ao fechar um incremento, atualize tarefas, evidências e limites reais. Confira o estado do repositório e preserve alterações concorrentes.

Esta adição organiza o contexto e não revoga instruções anteriores. Não concede autorização de publicação, deploy, alteração de credenciais, envio real, pareamento ou migração. Nesta tarefa não executar backup, dump, restore ou comandos agregados que os acionem; preservar os mecanismos existentes.
