# Candidato Broker para JRC Conversas — validação 17/09/2026

Base: `origin/main a16c1cd` e integração local `ce878f8`, conciliadas na branch `codex/broker-jrc-release-20260917`. Preservados os ajustes remotos de Compose; administração da plataforma restrita à API. O canvas experimental Broker não foi incorporado.

## Resultados

- 25/25 testes de integração PostgreSQL aprovados: `chatwoot-control-auth`, `chatwoot-control-storage`, `chatwoot-control-health`, `chatwoot-onboarding`, `chatwoot-tenants`. Bancos aleatórios criados e removidos pelo helper em um servidor PostgreSQL exclusivo da tarefa.
- 7/7 testes de `InstanceWorkspace` aprovados após atualizar a orientação para Flows dentro do JRC.
- Compose renderizado com valores fictícios e validado quanto ao isolamento das credenciais da plataforma (API, sem worker).
- Suíte completa: 1.078/1.078 testes aprovados, sem falhas, com `--maxWorkers=1`.
- Imagens locais API e web construídas com sucesso: `jrc-broker-api:release-20260917` e `jrc-broker-web:release-20260917`. TypeScript e Vite compilados no Dockerfile; instalação de produção informou zero vulnerabilidades.
- Inspeção dos 11 arquivos de assets extraídos da imagem web: nenhum segredo ou módulo de servidor encontrado. Verificação da fronteira do submódulo Evolution aprovada, incluindo o submódulo aninhado nos commits fixados.

Na primeira execução, faltava inicializar o submódulo Evolution fixado pelo projeto. Ele foi baixado no commit previsto; não foi atualizado para outra versão. A primeira tentativa de integração encontrou o PostgreSQL antigo desligado. Um servidor descartável separado foi criado; os 25 testes passaram nele. Testes de interface/PDF apresentaram limites de tempo durante builds concorrentes; os limites da suíte foram ajustados para 15 segundos por teste e 10 segundos nas esperas da interface. As asserções foram preservadas; os 22 casos afetados passaram isoladamente e a suíte completa passou em seguida. Não se alterou o comportamento do produto para ignorar essas falhas.

## Reprodução

```sh
git submodule update --init --recursive upstream/evolution-api
npm ci
npm run build
npm test -- --maxWorkers=1
# TEST_DATABASE_ADMIN_URL deve apontar SOMENTE para PostgreSQL de testes.
npx vitest run --config vitest.integration.config.ts apps/api/tests/integration/chatwoot-control-auth.test.ts apps/api/tests/integration/chatwoot-control-storage.test.ts apps/api/tests/integration/chatwoot-control-health.test.ts apps/api/tests/integration/chatwoot-onboarding.test.ts apps/api/tests/integration/chatwoot-tenants.test.ts --maxWorkers=1
docker build --target runtime -f infra/app/Dockerfile -t jrc-broker-api:release-20260917 .
docker build --target web -f infra/app/Dockerfile -t jrc-broker-web:release-20260917 .
```

O teste PDF exige Poppler no PATH. Os builds API/web executam TypeScript e Vite. O workflow de publicação inclui a verificação do bundle e demais gates definidos no repositório; a validação local descrita aqui não representa execução de todos os gates de produção.

Sem deploy ou envio de mensagens reais nesta tarefa. Para instalação conjunta, consulte [o guia da release](../operations/jrc-conversas-release.md) e `docs/DEPLOY-FLOWS-BROKER.md` no JRC.
