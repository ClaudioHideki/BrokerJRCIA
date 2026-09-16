# Prompt de execução para o Codex

Atue como engenheiro responsável pela evolução incremental da integração Broker JRC + JRC Conversas/Chatwoot. Desenvolva com base nos repositórios e no pacote de especificação e planos anexado. Não reconstrua o produto nem apresente mocks como integração real.

## Repositórios e baseline de referencia

```text
https://github.com/ClaudioHideki/BrokerJRCIA
Referencia consultada: 9e530170cdda90ee8b9b673a28723180e0b2e1a3

https://github.com/ClaudioHideki/jrc-conversas-nico-v12-2-7-comercial-integrado
Referencia consultada: 62c14af884c7f45fa640345556f2ffecc22113d8
```

Use os checkouts realmente disponíveis. Leia AGENTS.md, README, arquitetura, planos vigentes, manifests e testes de ambos antes de editar. Compare o HEAD atual com essas referencias. Preserve trabalho local; não faca reset/checkout destrutivo. As referencias não são ordem para regredir um checkout mais novo.

## Leia nesta ordem

```text
README-CODEX.md
docs/superpowers/specs/2026-09-16-broker-chatwoot-integration-design.md
docs/superpowers/plans/2026-09-16-01-broker-multi-destination-control.md
docs/superpowers/plans/2026-09-16-02-jrc-conversas-native.md
docs/superpowers/plans/2026-09-16-03-chatwoot-embedded-app.md
docs/validation/2026-09-16-integration-acceptance.md
docs/validation/2026-09-16-source-evidence.md
```

A especificação fecha a arquitetura; os planos detalham as tarefas. Regras de segurança, segregacao e preservacao de baseline não podem ser reduzidas para passar testes. Se o código real contrariar um detalhe do plano, registre a diferenca e aplique a adaptacao mínima compatível, mantendo a intencao. Novos endpoints/arquivos do plano não são recursos existentes antes da implementação.

## Escopo autorizado de desenvolvimento

Implementar e testar localmente os planos 01, 02 e 03, em sequencia e com gates por tarefa. Criar branches/worktrees isolados por tarefa, usando o fluxo de worktrees do repositório. Branches de integração propostas: `codex/broker-chatwoot-control` e `codex/jrc-broker-native`.

Não fazer push, merge, publicar imagens, implantar, acessar bancos produtivos, substituir webhook em uso, enviar mensagem real ou desconectar número real. Um piloto operacional depende de autorização e credenciais separadas. Não executar comandos de migração contra URL de banco sem confirmar ambiente isolado.

Se apenas um repositório estiver disponível, executar somente suas tarefas independentes e registrar o bloqueio do outro. Não afirmar alteração em arquivo que não foi acessado. Não copiar o projeto Rails para dentro do monorepo Broker.

## Arquitetura obrigatoria

- Broker permanece responsável pela sessão WhatsApp, identidade empresarial, providers e transporte. Evolution fica privado; frontend não chama engine.
- Chatwoot continua usando `Channel::Api`; reutilizar `ChatwootClient`, servicos, mappings, filas, assinatura e mídia cifrada existentes.
- Uma organização -> uma conta Chatwoot neste incremento. Suportar varias instalações entre organizações diferentes. Não ampliar agora para varias contas por organização.
- Criar origem EXTERNAL aprovada por tenant, mantendo `CHATWOOT_BASE_URL` como default MANAGED. Atualizar runtime, worker, retry e anexos; não apenas formulário.
- Platform token somente na origem MANAGED. URL + accountId + token do admin externo usam Application APIs; não exigir Super Admin do cliente.
- JRC Conversas: Vue -> Rails BFF autenticado -> API de controle Broker com chave limitada por organização/conta. Não forjar JWT nem passar token do admin aos agentes.
- Terceiros: portal autônomo e Dashboard App opcional. Não prometer instalação de botão nativo em frontend que não controlamos.
- Reutilizar webhook da inbox; não adicionar segundo transporte por webhook de conta, AgentBot, n8n ou integração direta Evolution-Chatwoot.

## Entregas

Plano 01: destinos externos seguros; upgrade compatível de banco; scopes/bindings específicos de controle; onboarding persistente/idempotente; pair/status com contrato existente; evidências de transporte e testes de isolamento.

Plano 02: configuração Rails cifrada; policies e endpoints por conta/inbox; card e fluxo nativo de QR; acesso de agente por concessão explícita; status no atendimento; testes backend/frontend/contrato.

Plano 03: página embed restrita; CSP por origem; handshake first-party com sessão curta; contexto postMessage sem poder de autenticação; registro opcional de Dashboard App; alternativa portal; testes com cookies de terceiros bloqueados.

## Regras que não podem ser ignoradas

Não liberar URL externa sem controles de rede; validar A/AAAA e o IP efetivamente conectado, inclusive IPv6/rebinding/redirect. Não enviar token da API a CDN. Origem em uso não muda por simples edicao de formulário.

Não abrir guards JWT existentes a qualquer API key. A chave do Rails usa somente escopos chatwoot específicos, não instances:write. O usuário restrito do app externo não deve receber OPERATOR legado como se fosse papel limitado. Validar empresa ativa, conta, inbox, grant e revogação em cada mutacao.

Administrador pode criar/vincular; agente só atende e reconecta quando delegado. Agente não troca número, não cria primeira vinculacao e não desconecta. Confirmar identidade do número pelo provider antes de liberar transporte após reconexão; divergencia exige admin.

Broker e o único criador da inbox no onboarding. Não manter transação Rails/PostgreSQL aberta enquanto espera chamada externa. Persistir progresso; timeout após POST remoto pode significar operação realizada: UNKNOWN exige reconciliação, não repetição cega.

QR usa `ConnectionResponseSchema`, e temporário e fica apenas em memoria da tela autorizada. Não criar GET qrcode ficticio, gravar QR em atributos da inbox, salvar em storage do navegador ou inclui-lo em logs/screenshots reais. GET status não inicia sessão.

Não usar `currentAgent` recebido por postMessage como autenticação. Embed exige sessão própria e curta; não liberar admin em iframe nem CORS global. Remover X-Frame-Options conflitante somente na rota embed autorizada.

Caixa READY não comprova número conectado; número conectado não comprova entrada e saida. Não considerar perfil 200, mock ou simples exibicao de QR como homologação.

## Método de execução

Para cada tarefa: escrever teste relevante, executar RED real, implementar mínima alteração, executar GREEN, regressão da area, revisar diff/segredos e fazer commit local focado. Não usar teste que apenas afirma a própria implementação como evidência de segurança. Não enfraquecer schemas/auth/RLS para passar.

Execute testes disponíveis nos manifests; no Broker, npm build/typecheck/test/integration/compiled/E2E/contratos/notices/submodule; no JRC, RSpec, Vitest/pnpm, ESLint, RuboCop e build real do CI. Gerar/revisar/versionar novo OpenAPI e depois verificar reprodutibilidade. Não exigir diff vazio contra contrato antigo antes de aceitar a alteração intencional. Preservar auditorias históricas.

Use framework de testes e padrões já presentes. No JRC, respeitar Composition API, Tailwind, i18n e overlays enterprise. Não alterar NICO, Comercial, licencas ou capacidades Meta sem relacao com a integração.

Prosseguir entre tarefas após gate aprovado pelos testes e revisão, sem pedir confirmação repetida para cada arquivo. Falhas de ambiente são BLOCKED, não PASS. Credenciais ausentes não justificam inventar resultado: concluir partes independentes e relatar exatamente o que falta para homologação.

## Primeira resposta e relatório final

Comece informando os HEADs realmente encontrados, componentes reutilizaveis, divergencias do baseline e a primeira tarefa. Depois execute; não parar em outro plano generico.

Ao concluir cada plano, apresentar branch/commits, arquivos e migrações, endpoints e exemplos sanitizados, testes executados com resultado, riscos e bloqueios. Preencher a matriz de aceite. Separar explicitamente: código implementado, teste local, Chatwoot remoto, telefone real. Finalizar com procedimento de ativação em homologação e rollback, sem executar deploy automaticamente.
