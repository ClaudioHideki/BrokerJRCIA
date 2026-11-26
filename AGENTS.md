# JRC WhatsApp Broker contributor rules

- Read the approved design and the current phase plan before editing.
- Use TDD for every feature and bug fix.
- Never commit secrets, customer payloads, telephone numbers, or Baileys auth state.
- Preserve all third-party licenses and attributions.
- Do not deploy to production without an explicit approved release task.
- Run `npm test` and review `git diff --check` before every commit.

<!-- jrc-operational-init:v1 -->
## Segundo Cérebro e Governança Operacional

- **Projeto:** Broker JRC.
- **Descrição:** SaaS independente e multiempresa de conectividade WhatsApp, eventos, mensagens, mídia, automações e integrações.
- **Stack principal:** TypeScript, Node.js, Fastify, React/Vite, PostgreSQL, Redis, Evolution/Baileys e armazenamento compatível com S3.
- **Natureza:** Brownfield; preservar fontes, histórico e regras anteriores.
- **Tipo desta raiz:** application.

### Leitura e manutenção do contexto

1. Leia as instruções específicas anteriores deste arquivo e o checkpoint/README do checkout real.
2. Consulte [ROADMAP.md](ROADMAP.md), [TASKS.md](TASKS.md) e [a regra operacional](.agents/rules/operational-governance.md).
3. Consulte [domínio](docs/domain/glossary.md), [regras de negócio](docs/domain/business-rules.md), [personas](docs/domain/personas.md), [arquitetura](docs/architecture/system-overview.md) e [modelo de dados](docs/architecture/data-model.md).
4. Registre uma mudança relevante de decisão em [ADR](docs/adr/README.md); não reescreva a história de uma decisão já aceita.
5. Ao fechar um incremento, atualize tarefas, evidências e limites reais. Confira o estado do repositório e preserve alterações concorrentes.

Esta adição organiza o contexto e não revoga instruções anteriores. Não concede autorização de publicação, deploy, alteração de credenciais, envio real, pareamento ou migração. Nesta tarefa não executar backup, dump, restore ou comandos agregados que os acionem; preservar os mecanismos existentes.

## Regressões de entrega para o JRC Conversas

- **Mensagens antigas sem tentativa, atrás de uma operação incerta na mesma conversa.** Confirme os dois IDs canônicos e a caixa/conversa remota. O comando `review-pending-mirror` apresenta o motivo de espera e registra a aprovação de um único trabalho. A recuperação usa o recibo idempotente, preserva o horário original e mantém a tentativa incerta em revisão. Os testes com PostgreSQL cobrem texto e mídia, entrada e saída observada, troca de contato no destino e repetição da aprovação. A suíte de normalização cobre dois links com e sem prévia, inclusive quando o WhatsApp só informa o número. [Procedimento](docs/operations/chatwoot-external.md#revisão-de-uma-mensagem-individual-já-recebida-pelo-broker) · [Teste de integração](apps/api/tests/integration/chatwoot-live-receipts.test.ts) · [Teste de entrada](apps/api/tests/unit/qr-events.test.ts)

Documente cada falha confirmada com o componente, a causa, a correção, o teste automatizado e o estado do commit, CI, imagem e implantação. Registre o aceite de entrega com identificadores correlacionados e dados de teste sintéticos nos exemplos de código.

Execute `npm run test:integration -- apps/api/tests/integration/chatwoot-live-receipts.test.ts` com o PostgreSQL de testes configurado. Confira o total executado antes de registrar o resultado.

- **Entrada nova bloqueada por pendência antiga.** A versão `24656f3` permite espelhar uma entrada individual nova com recibo idempotente quando existe uma operação anterior incerta. A versão `d99b7cf` preserva o isolamento das mensagens anteriores à ativação mesmo após a chegada de outro recibo. Os cenários de deduplicação, pendência antiga e histórico devem passar com PostgreSQL. [Teste de integração](apps/api/tests/integration/chatwoot-live-receipts.test.ts) · [Decisão sobre novas entradas](docs/adr/0007-independent-live-incoming-mirrors.md)
- **Espera entre ciclos do worker.** A versão `d222f08` processa até quatro trabalhos de entrega por ciclo, devolvendo controle após uma operação demorada. A auditoria de 26/11 verificou o código em execução e 24 testes de integração. O mesmo teste cobre o limite por ciclo e o isolamento do histórico. [CI](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/45862676504) · [Publicação](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/45862799222)
