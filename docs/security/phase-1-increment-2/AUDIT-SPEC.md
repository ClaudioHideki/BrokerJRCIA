# Especificação da auditoria de segurança — Fase 1, Incremento 2

## Objetivo e escopo

Esta auditoria cobre a console web operacional e sua integração com o backend multicliente do JRC WhatsApp Broker. O escopo inclui sessão de navegador, contratos HTTP, PostgreSQL/RLS, autenticação, RBAC, API keys, instâncias, providers, OpenAPI, dependências, histórico Git JRC, bundles compilados e container. Meta real, mensageria, mídia, webhooks completos, billing, WhatsApp Calling, chatbot, filas e deploy permanecem fora do incremento.

O navegador acessa somente a API JRC por uma origem HTTPS comum. A Evolution permanece privada, sem rota pública, credencial administrativa ou contrato próprio exposto ao cliente. O submódulo `upstream/evolution-api/**` é excluído da varredura histórica e validado separadamente por origem, pin, atribuições e fronteira.

## Cinco eixos obrigatórios

1. Isolamento multitenant: dados voláteis do frontend, rotas, RLS e operações usam somente a organização ativa.
2. Autorização não dependente do frontend: controles visuais complementam, mas nunca substituem, RBAC no servidor.
3. IDOR: identificadores, cursores e recursos são revalidados no tenant ativo antes de leitura, mutação ou chamada ao provider.
4. Segredos expostos: access/refresh/selection tokens, API keys, credenciais, QR, pairing e dados pessoais não aparecem em logs, storage, URLs, histórico, bundles ou capturas documentais.
5. Inputs inseguros/XSS: contratos Zod, escaping do React, validação estrita de PNG, ausência de HTML não confiável e políticas da borda protegem a superfície do navegador.

Todos os cinco eixos são aplicáveis neste incremento. Controles complementares cobrem autenticação, CSRF/Origin, rate limiting, logging/auditoria, fronteira do provider, idempotência/DoS, supply chain, OpenAPI e container.

## Método e evidência

Cada conclusão referencia arquivo e linhas. O inventário de rotas é derivado do OpenAPI e cruzado com política explícita que registra autenticação, permissão, RLS, idempotência, exposição de desafio, `handlerFile`, `handlerLine` e `ownershipCheck`. Testes unitários, HTTP, PostgreSQL/Redis reais e Playwright exercitam os controles.

A varredura do histórico alcançável considera somente o repositório JRC. A varredura dos bundles inclui `apps/api/dist/**`, `apps/web/dist/**` e os packages compilados, excluindo source maps, dependências e upstream. Canários sintéticos e assinaturas de alta confiança são detectados em memória; os artefatos persistem apenas metadados e fingerprints HMAC-SHA-256. Valores nunca são impressos. Nomes `VITE_*` não aprovados são reportados sem seus valores.

## Severidade, estado e gate

- `CRITICAL` (`#B91C1C`): comprometimento amplo ou imediato; prioridade P1.
- `HIGH` (`#EA580C`): impacto grave e explorável; prioridade P2.
- `MEDIUM` (`#D97706`): impacto relevante sob condições adicionais; prioridade P3.
- `LOW` (`#2563EB`): hardening ou impacto limitado; prioridade P4.
- `STRENGTH` (`#059669`): controle positivo comprovado, sem efeito bloqueante.

`INFO` usa `#475569` e o fundo usa `#F8FAFC`. Estados aceitos: `OPEN`, `ACCEPTED`, `FIXED` e `NOT_APPLICABLE`. A geração sempre funciona; somente `security:audit:gate` bloqueia findings `CRITICAL` ou `HIGH` em estado `OPEN`.

## Artefatos e PDF

`findings.json` contém findings estruturados e uma coleção `strengths`. Cada finding possui categoria, arquivo, `lineStart`, `lineEnd`, `codeExcerptMasked`, explorabilidade, condições, critérios de aceite, labels sugeridas e issue Markdown completa entre `--- ISSUE n ---` e `--- FIM ISSUE n ---`.

O relatório usa o título exato “Relatório de Auditoria de Segurança — JRC WhatsApp Broker”, capa pt-BR, resumo, escopo, nota metodológica, chips, rosca, barras, pontos fortes/fracos, tabela, prioridades P1 em diante, inventário, varreduras e issues. O PDF é A4, tem margens de 18 mm, cabeçalho e paginação. A verificação obtém o page count, rasteriza todas as páginas a pelo menos 150 DPI e exige inspeção visual de cada imagem.

## Pendência administrativa conhecida

O GitHub Actions permanece fail-closed enquanto o repository secret `AUDIT_FINGERPRINT_SECRET` não estiver configurado. O valor deve ser aleatório, ter no mínimo 16 caracteres e preferencialmente 32 ou mais. Ele nunca deve ser incluído em chat, arquivo, log ou fallback versionado.
