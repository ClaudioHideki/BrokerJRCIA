# Fase 1 — Incremento 1: runtime e fronteiras operacionais

Este documento complementa a especificação aprovada do backend multicliente e Baileys. O incremento entrega uma API própria da JRC em um monólito modular TypeScript, sem frontend, worker, filas, webhooks completos ou integração Meta real.

## Composição do runtime

O entrypoint compilado é `apps/api/dist/server.js`. Antes de abrir o socket ele valida todas as URLs, segredos separados e parâmetros de proteção. O encerramento por `SIGINT` ou `SIGTERM` fecha Redis e os pools PostgreSQL. O processo HTTP executa como usuário não-root na imagem imutável registrada em `infra/app/node-image.lock`.

A documentação OpenAPI pública é gerada de forma determinística em `docs/api/openapi.json`. A Swagger UI fica desabilitada por padrão. Em produção, sua habilitação exige opt-in e bind interno explícitos.

## Fronteira com a Evolution

A Evolution é um detalhe privado do provider BAILEYS. Sua credencial administrativa pertence à plataforma JRC, nunca ao tenant, e não aparece em contratos, logs ou respostas públicas. O compose de produção não publica a porta da Evolution: ela existe apenas na rede Docker interna `provider`.

Rotas concluem transações PostgreSQL antes de qualquer chamada HTTP ao provider. Provisionamento usa uma chave upstream determinística e lease persistida, permitindo reconciliação sem duplicidade após timeout. As operações administrativas `lookupInstance`, `reconcileProvisioning` e `deprovisionInstance` não têm endpoint público.

## Isolamento e operação

Toda operação tenant usa transação curta com a role `jrc_app` e `SET LOCAL` do `organization_id`. RLS nega acesso sem contexto e impede herança de tenant entre conexões do pool. Login e seleção de organização usam o acesso limitado `jrc_auth`.

Comandos administrativos internos:

- `npm run build --workspace @jrc/api` prepara `bootstrap` e `tenant:create`.
- `npm run bootstrap --workspace @jrc/api` cria a primeira organização e OWNER.
- `npm run tenant:create --workspace @jrc/api` cria tenants posteriores sem redefinir senha de usuário existente.

Entradas sensíveis são fornecidas por variáveis de ambiente ou prompt seguro e nunca devem ser persistidas em arquivos `.env` reais.

## Validação local

Os gates sem Evolution são:

```text
npm run build
npm run typecheck
npm test
npm run test:integration
npm run test:compiled
npm run openapi:generate
docker build --file infra/app/Dockerfile --tag jrc-whatsapp-broker:phase-1-increment-1 .
npm run test:container
npm audit --audit-level=high
```

O smoke da Evolution é separado e opt-in com `EVOLUTION_SMOKE_ENABLED=true`. Ele usa somente dados técnicos efêmeros e sempre executa `deprovisionInstance` em `finally`, confirmando a ausência com `lookupInstance`. `disconnect` não é cleanup, e reconciliação nunca é usada para comprovar ausência porque pode reprovisionar.
