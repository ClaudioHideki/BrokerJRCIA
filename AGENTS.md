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

- **Nome de exibição nulo no JRC.** Em 27/11/2026, a revisão de um espelho no Broker V6 interrompeu o lote ao ler `meta.sender.name: null` no GET da conversa. Os dois parsers do mesmo endpoint agora aceitam texto, `null` e omissão para esse campo de exibição. A identidade continua validada por conta, caixa, conversa, contato, telefone e vínculo de origem. Nos testes, incluir nome nulo com rota correta e com identificador, telefone, origem ou caixa divergentes. Rodar `npx vitest run apps/api/tests/unit/chatwoot-client.test.ts apps/api/tests/unit/flow-chatwoot-client.test.ts` e a suíte PostgreSQL `apps/api/tests/integration/chatwoot-live-receipts.test.ts`, que exercita a revisão e a revalidação antes do espelhamento.

- **Mensagens atuais aguardavam atrás de espelhos revisados.** Na base `49eb82c`, o teste de PostgreSQL com duas revisões antigas entregava as duas antes da primeira mensagem atual. A caixa agora mantém uma cota de até três trabalhos correntes para cada oportunidade de revisão. Os workers atualizam a cota na mesma transação que reivindica o trabalho. O teste inclui workers concorrentes, reinício a cada rodada, caixas com uma única mensagem e resposta pública autorizada. Execute `npm run test:integration -- apps/api/tests/integration/chatwoot-live-receipts.test.ts apps/api/tests/integration/chatwoot-human-intents.test.ts apps/api/tests/integration/chatwoot-claim-migration.test.ts`. [Procedimento de implantação](docs/operations/chatwoot-external.md#prioridade-do-atendimento-e-fila-revisada)

- **Primeira saída observada no WhatsApp atrás de um espelho incerto.** Na base `a5e0d8b`, um evento QR ao vivo criava a mensagem canônica, mas faltava no trabalho de espelhamento o destino aprovado na entrada. O teste de PostgreSQL reproduziu zero mensagens no JRC. Uma observação individual nova, identificada na primeira transação, registra o destino, a revisão da credencial, o contato e a referência da observação. O worker confere o provedor, a caixa e o contato remoto antes do espelhamento independente. As confirmações de entrega e leitura dependem do recibo nativo da primeira gravação no JRC. Execute `npm run test:integration -- apps/api/tests/integration/chatwoot-live-receipts.test.ts -t "first live QR observation"`. O cenário verifica uma mensagem no JRC e zero envios ao WhatsApp. [Regressão](apps/api/tests/integration/chatwoot-live-receipts.test.ts)

- **Espelho de uma saída observada que ficou incerta.** Em 26/11/2026, uma conversa com uma saída já observada no WhatsApp passava a reter entradas novas e mídias revisadas. O worker reconhecia somente uma entrada como espelho anterior incerto. No commit `8b5a796`, três regressões reproduziram a falha. A seleção e a verificação anterior à gravação no JRC agora exigem evidência para a mesma caixa, contato, conversa e tentativa, além de identificadores distintos das duas mensagens no provedor. A tentativa antiga conserva seu estado. Execute `npm run test:integration -- apps/api/tests/integration/chatwoot-live-receipts.test.ts apps/api/tests/integration/chatwoot-human-intents.test.ts` com PostgreSQL de teste. Os casos exercitam entrada, mídia de saída observada, identificadores conflitantes, operação humana ou automática e mudança de evidência após a seleção.

- **Resposta humana em uma segunda conversa aberta do mesmo contato.** Em 26/11/2026, uma pendência de espelhamento de outro contato bloqueava a primeira resposta humana em uma conversa sem vínculo. O teste anterior produzia zero saídas. Uma nova intenção pública assinada pode iniciar outro ciclo após conferência da mensagem salva no JRC, do remetente, da caixa, do contato e de sua origem. As duas conversas preservam os vínculos de seus respectivos históricos. O teste exige uma única saída para webhooks repetidos e mantém em revisão o histórico anterior, o contato ambíguo e a mensagem antiga entregue tardiamente. Execute `npm run test:integration -- apps/api/tests/integration/chatwoot-human-intents.test.ts apps/api/tests/integration/chatwoot-conversation-cycles.test.ts` com PostgreSQL sintético. [Regressão](apps/api/tests/integration/chatwoot-human-intents.test.ts)

- **Mensagens antigas sem tentativa, atrás de uma operação incerta na mesma conversa.** Confirme os dois IDs canônicos e a caixa/conversa remota. O comando `review-pending-mirror` apresenta o motivo de espera e registra a aprovação de um único trabalho. A recuperação usa o recibo idempotente, preserva o horário original e mantém a tentativa incerta em revisão. Os testes com PostgreSQL cobrem texto e mídia, entrada e saída observada, troca de contato no destino e repetição da aprovação. A suíte de normalização cobre dois links com e sem prévia, inclusive quando o WhatsApp só informa o número. [Procedimento](docs/operations/chatwoot-external.md#revisão-de-uma-mensagem-individual-já-recebida-pelo-broker) · [Teste de integração](apps/api/tests/integration/chatwoot-live-receipts.test.ts) · [Teste de entrada](apps/api/tests/unit/qr-events.test.ts)

Documente cada falha confirmada com o componente, a causa, a correção, o teste automatizado e o estado do commit, CI, imagem e implantação. Registre o aceite de entrega com identificadores correlacionados e dados de teste sintéticos nos exemplos de código.

Execute `npm run test:integration -- apps/api/tests/integration/chatwoot-live-receipts.test.ts` com o PostgreSQL de testes configurado. Confira o total executado antes de registrar o resultado.

- **Vários recibos da mesma mensagem.** Uma mudança de `DELIVERED` para `READ` gera um segundo trabalho e a primeira revisão recusava a mensagem mesmo quando ambos tinham zero tentativas. A revisão registra quais trabalhos pertencem ao mesmo ID. Somente o escolhido pode criar a mensagem no JRC. Os demais dependem da confirmação nativa e do vínculo remoto para aplicar o estado. A suíte PostgreSQL acima verifica a mudança de digest, o bloqueio após tentativa ou troca de contato, um único envio ao JRC e uma única confirmação para texto e mídia.

- **Entrada nova bloqueada por pendência antiga.** A versão `24656f3` permite espelhar uma entrada individual nova com recibo idempotente quando existe uma operação anterior incerta. A versão `d99b7cf` preserva o isolamento das mensagens anteriores à ativação mesmo após a chegada de outro recibo. Os cenários de deduplicação, pendência antiga e histórico devem passar com PostgreSQL. [Teste de integração](apps/api/tests/integration/chatwoot-live-receipts.test.ts) · [Decisão sobre novas entradas](docs/adr/0007-independent-live-incoming-mirrors.md)
- **Espera entre ciclos do worker.** A versão `d222f08` processa até quatro trabalhos de entrega por ciclo, devolvendo controle após uma operação demorada. A auditoria de 26/11 verificou o código em execução e 24 testes de integração. O mesmo teste cobre o limite por ciclo e o isolamento do histórico. [CI](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/45862676504) · [Publicação](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/45862799222)

- **Provisionamento e reconciliação de caixa.** Para mudanças no vínculo do Broker com uma caixa da API do JRC, verificar a conta e o ID retornados, preservar o primeiro ID confirmado no banco e exigir uma nova escolha no painel quando o destino mudar. Ensaiar callback reaparecendo em outra caixa, catálogo indisponível e mudança das revisões entre a escolha e o envio. Rodar `apps/api/tests/unit/chatwoot-client.test.ts`, `apps/web/src/integrations/ChatwootPanel.test.tsx` e as suítes PostgreSQL `chatwoot-onboarding.test.ts`, `central-cutover.test.ts` e `partner-messaging.test.ts` em banco descartável. A configuração usa dados sintéticos. O aceite físico de sessão, arquivos e entrega pertence ao inventário operacional.
