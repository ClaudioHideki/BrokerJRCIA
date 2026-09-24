# JRC WhatsApp Broker

## Candidato atual: jornadas do Broker e integração com JRC Conversas

O candidato de 23/09/2026 consolida as caixas Meta/QR, ações seguras de ciclo de
vida e o runtime de Automações da JRC. A base conciliada é `f8e81df`. A integração
nativa com o JRC Conversas ainda exige adoção de caixas existentes, identidade
delegada, um único motor por caixa e handoff/retomada coordenados nos dois
repositórios. Consulte o [estado, contratos existentes e próximos incrementos](docs/integrations/jrc-conversas-modulos-broker.md),
a [matriz de QA desta base](docs/qa/2026-09-23-broker-journeys.md) e o
[registro anterior do candidato omnichannel](docs/validation/2026-09-18-broker-omnichannel.md).
Testes sintéticos ou isolados não substituem pareamento real nem homologação HTTPS
com duas empresas. Imagens e deploy permanecem etapas separadas.

## Repositório e imagens

Repositório de entrega: [ClaudioHideki/BrokerJRCIA](https://github.com/ClaudioHideki/BrokerJRCIA).
Para obter os fontes e as dependências upstream fixadas:

```bash
git clone --recurse-submodules https://github.com/ClaudioHideki/BrokerJRCIA.git
```

A [CI](https://github.com/ClaudioHideki/BrokerJRCIA/actions/workflows/ci.yml) verifica cada envio.
O [workflow de imagens](https://github.com/ClaudioHideki/BrokerJRCIA/actions/workflows/images.yml)
é manual: `publish=true` publica `ghcr.io/claudiohideki/brokerjrcia-api:<commit>` e
`ghcr.io/claudiohideki/brokerjrcia-web:<commit>`. API e worker usam a mesma imagem.
Use os digests retornados pelo registry no [Compose do Dokploy](infra/dokploy/compose.yaml),
conforme o [guia de instalação](docs/operations/dokploy-saas.md).
As imagens não incluem empresas, senhas, sessões ou bancos do ambiente local.

## Integração com JRC Conversas e Meta

O conector agora vincula uma conta por empresa, cria caixas API, associa atendentes e transporta mensagens e anexos nos dois sentidos. Filas persistentes, recuperação de falhas e conciliação protegem contra duplicação. A administração usa e-mail e senha no modo configurado para esta instalação.

Consulte [configuração e recuperação](docs/operations/integracao-jrc-conversas.md) e [validação desta entrega](VALIDACAO-INTEGRACOES-20260915.md). O [guia anterior](GUIA-INTEGRACOES-CHATWOOT-META-20260915.md) registra o diagnóstico que antecedeu o desenvolvimento. A homologação com a instalação remota e ativos Meta depende do domínio e das credenciais da JRC.

## Administração atualizada

Acesse `/jrc` para o dashboard administrativo no padrão visual da console executiva,
com empresas, usuários, planos, monitoramento e suporte. Consulte
[a atualização da administração](ATUALIZACAO-ADMIN-20260915.md).

## Atualização: clientes de teste e marca JRC

Consulte [a atualização de 15/09/2026](ATUALIZACAO-CLIENTES-TESTE-20260915.md)
para os dois clientes isolados, o administrador local com e-mail e senha, os canais com a marca JRC
e a validação em PostgreSQL real. Os acessos locais usam `/login` e `/jrc`, sem `?demo=1`.

## Refatoração da console — 15/09/2026

Comece por [ENTREGA-20260915.md](ENTREGA-20260915.md), pelo
[plano mestre revisado](PLANO-MESTRE-JRC-BROKER-v2.md) e pelas
[evidências de validação](VALIDACAO-20260915.md).

Prévia local: execute `npm run dev:web` e abra
`http://127.0.0.1:4317/dashboard?demo=1`. Esse modo usa dados sintéticos,
só existe em desenvolvimento e bloqueia alterações reais.
Reabra essa URL para reiniciar a demonstração após atualizar a página.

O texto abaixo documenta também etapas anteriores; seus resultados históricos
não substituem a validação desta versão.

Broker SaaS multicliente da JRC para integração com WhatsApp por meio da Meta Cloud API oficial e de sessões compatíveis via Baileys.

## Base anterior: Fase 2 — Incremento 1

A Fase 2 — Incremento 1 integra Meta/Typebot e a operação SaaS: templates com variáveis BODY, envio individual, recebimento assinado, histórico, vínculo de fluxo e pausa para atendimento; administração JRC com senha/TOTP, empresas, usuários, planos/limites e suporte auditado. PostgreSQL mantém RLS, inbox/outbox, sessões e limites transacionais; workers respeitam suspensão e partição de empresas. Os testes usam Meta e Typebot sintéticos e não comprovam homologação externa.

A Evolution API é uma engine interna atribuída e substituível, preservada para o adapter Baileys existente. Evolution e Ligo são referências; a interface e os contratos JRC são próprios. Credenciais de providers permanecem no servidor. O novo cliente Cloud API atende o módulo de mensageria; o antigo esqueleto Meta de gerenciamento de instâncias não implementa Embedded Signup.

O novo módulo SaaS implementa Embedded Signup do aplicativo JRC, validação dos ativos, registro do número, consulta de pendências e revogação. Homologação Meta real, Coexistence, campanhas, importação/listas, mídia e editor Typebot incorporado continuam pendentes. Consulte o [guia Dokploy/GHCR, backup e operação](docs/operations/dokploy-saas.md), [administração JRC](docs/operations/saas-admin.md), [limites e isolamento](docs/operations/saas-enforcement.md), [Meta SaaS](docs/operations/saas-meta.md) e o [relatório desta fase](docs/security/phase-2-increment-1/relatorio.md). Os relatórios da Fase 1 são históricos. Nenhuma publicação foi executada.

Rotas da interface: `/jrc` (equipe JRC), `/login` (empresas), `/minha-empresa` (limites e atalhos), `/whatsapp-oficial` (autorização Meta), `/conexoes` (Baileys) e `/mensagens` (atendimento/Typebot). Arquivos para futura instalação: `infra/dokploy/compose.yaml`, `infra/dokploy/.env.example`, `infra/app/Dockerfile` e `.github/workflows/images.yml`.

## Pré-requisitos locais

- Node.js 24.19.0;
- npm compatível com o lockfile;
- Git com suporte a submódulos;
- Docker com Docker Compose;
- Chromium instalado pelo Playwright (`npx playwright install chromium`) para os testes E2E;
- Poppler (`pdfinfo` e `pdftoppm`) para o gate visual local da auditoria.

## Preflight e validação

```bash
git submodule update --init --recursive upstream/evolution-api
npm ci
npm run clean
npm run build
npm run test:web:bundle
npm run typecheck
npm run test:compiled
npm test
npm run test:web
npm run test:integration
npm run test:e2e
npm run openapi:generate
git diff --exit-code -- docs/api/openapi.json
npm run security:contracts
npm run security:submodule
npm audit --audit-level=high
```

Os testes de integração e E2E exigem PostgreSQL e Redis reais por meio de `TEST_DATABASE_ADMIN_URL` e `TEST_REDIS_URL`. O E2E cria e remove um banco isolado, inicia a API JRC real com provider falso controlado e serve o bundle Vite de produção. O CI executa migrations a partir de um banco vazio e também valida a imagem, o entrypoint compilado, o bundle web e os artefatos reproduzíveis da auditoria.

O smoke da Evolution é separado e opt-in. Execute `npm run test:smoke:evolution` apenas em ambiente local autorizado, com `EVOLUTION_SMOKE_ENABLED=true` e secrets fornecidos pela sessão. O teste remove a instância efêmera em `finally` e confirma a ausência por `lookupInstance`.

## Containers

```bash
docker build --file infra/app/Dockerfile --tag jrc-whatsapp-broker:phase-1-increment-2 .
npm run test:container
```

A imagem usa Node.js 24.19.0 por tag e digest imutável, executa como usuário não-root e inicia o entrypoint compilado. Em produção, a Evolution fica somente na rede privada do provider e não publica porta externa.

## Auditoria de segurança

```bash
npm run security:audit:generate
npm run security:audit:verify-pdf
npm run security:audit:gate
git diff --exit-code -- docs/security/phase-1-increment-2
```

A geração sempre atualiza os artefatos diagnósticos sanitizados. A verificação intermediária usa Poppler para confirmar A4, rasterizar todas as páginas a 150 DPI e validar cabeçalho e paginação da página 2 em diante. O gate separado bloqueia achados `CRITICAL` ou `HIGH` abertos, e a verificação do diff garante que o relatório versionado é reproduzível e está atualizado. Os scripts ficam em `scripts/security/`; valores secretos nunca integram os artefatos.

`security:audit:generate` exige `SOURCE_DATE_EPOCH` e uma chave exclusiva em `AUDIT_FINGERPRINT_SECRET`, fornecida pelo ambiente/CI e distinta dos segredos da aplicação. Ela é usada somente para fingerprints HMAC sanitizados; seu valor nunca é persistido no relatório. No GitHub, configure o repository secret com esse nome usando um valor aleatório de pelo menos 16 caracteres (preferencialmente 32 ou mais). Não publique o valor em chat, logs ou arquivos e não crie fallback no workflow.

## Documentação

- [Integração com JRC Conversas: estado e próximos incrementos](docs/integrations/jrc-conversas-modulos-broker.md)
- [Matriz QA das jornadas do Broker em 23/09/2026](docs/qa/2026-09-23-broker-journeys.md)
- [Especificação superior de arquitetura](docs/superpowers/specs/2026-09-03-jrc-whatsapp-broker-design.md)
- [Especificação do Incremento 1](docs/superpowers/specs/2026-09-03-phase-1-increment-1-backend-multitenant-baileys-design.md)
- [Plano de implementação do Incremento 1](docs/superpowers/plans/2026-09-03-phase-1-increment-1-implementation-plan.md)
- [Especificação da Console Web](docs/superpowers/specs/2026-09-06-phase-1-increment-2-web-console-design.md)
- [Plano de implementação da Console Web](docs/superpowers/plans/2026-09-06-phase-1-increment-2-web-console-implementation-plan.md)
- [Runbook HTTPS e mesma origem da Console](docs/operations/web-console.md)
- [Runtime e fronteiras operacionais](docs/architecture/phase-1-increment-1.md)
- [Contrato OpenAPI gerado](docs/api/openapi.json)
- [Auditoria histórica do Incremento 1](docs/security/phase-1-increment-1/AUDIT-SPEC.md)
- [Auditoria da Console Web](docs/security/phase-1-increment-2/AUDIT-SPEC.md)
- [Registro do upstream Evolution](docs/legal/evolution/UPSTREAM.md)
- [Aviso administrativo obrigatório](docs/legal/evolution/USAGE-NOTICE.md)

## Segurança e licenças

Credenciais, tokens, API keys, QR Codes, pairing codes, sessões Baileys, telefones e dados de clientes não podem ser enviados ao Git nem incluídos em logs. Use o gerenciador de secrets do ambiente; arquivos `.env` reais são proibidos. Dependências e código de terceiros devem preservar suas licenças, avisos e atribuições.
