# Especificação da auditoria de segurança — Fase 1, Incremento 1

## Objetivo e escopo

Esta auditoria cobre o backend multicliente e o provider Baileys do JRC WhatsApp Broker no Incremento 1. A avaliação considera código-fonte JRC, migrations, OpenAPI, testes, configuração do container, dependências, bundles compilados e histórico Git alcançável do repositório raiz. O submódulo `upstream/evolution-api/**` é excluído da varredura histórica e permanece coberto somente pelos controles de fronteira, pin e atribuição.

Frontend funcional, worker, filas, webhooks completos e Meta real estão fora deste incremento. Verificações exclusivas de frontend e execução de XSS no navegador são registradas como `NOT_APPLICABLE`; validação e codificação de inputs da API continuam obrigatórias.

## Modelo de ameaça

Os adversários considerados incluem usuários não autenticados, credenciais comprometidas, membros com papel insuficiente, tenant malicioso, clientes tentando IDOR, abuso concorrente de tokens/idempotência, provider upstream indisponível ou malformado, vazamento por logs/artefatos e comprometimento de supply chain. A Evolution é tratada como serviço interno e não confiável na fronteira de parsing.

## Cinco eixos obrigatórios

1. Isolamento multitenant: `organization_id`, RLS forçada, contexto transacional, pools e ausência de vazamento.
2. Permissões somente no frontend: RBAC deve existir no servidor; neste incremento não há frontend funcional.
3. IDOR: todo identificador, cursor e recurso tenant deve ser revalidado no contexto ativo antes de provider ou mutação.
4. Segredos expostos: tokens, API keys, credenciais, desafios e dados pessoais não podem aparecer em logs, banco aberto, histórico ou bundles.
5. Inputs inseguros/XSS: contratos Zod estritos, respostas sanitizadas, parsing hostil do provider e registro explícito da parte exclusiva de navegador como não aplicável.

Controles complementares cobrem autenticação e enumeração, API keys/tokens, rate limiting e falha Redis, logging/auditoria, SSRF e boundary Evolution, idempotência/DoS, dependências, OpenAPI e container non-root com imagem imutável.

Cada categoria declarada deve possuir rastreabilidade estruturada em pelo menos um `finding` ou `strength`, com arquivo, intervalo de linhas e caminhos de evidência. A geração é rejeitada pelos testes se qualquer categoria ficar sem conclusão documentada.

## Evidência e método

Cada conclusão referencia arquivos e linhas positivas. O inventário de rotas é derivado do OpenAPI e cruzado com uma política explícita por operação. Testes automatizados exercitam controles unitários, HTTP e PostgreSQL real. Varreduras de histórico e bundles processam conteúdo em memória, nunca encaminham stdout/stderr bruto e persistem somente regra, categoria, caminho, linha, SHA abreviado e fingerprint HMAC.

Canários sintéticos distintos representam senha, JWT, refresh token, selection token, API key, chave Evolution, QR Code, pairing code, telefone e cookie. Os valores são usados apenas por fixtures de teste e nunca aparecem nos artefatos gerados ou em mensagens do scanner. Regras adicionais, restritas a assinaturas de alta confiança (tokens GitHub/Slack, access keys AWS e chaves privadas), complementam a detecção sem transformar o mecanismo de sanitização em um regex amplo. Nomes de campos, controles e arquivos podem aparecer.

O arquivo canônico `scripts/security/secret-canaries.mjs` é a única exclusão JRC do detector de valores-canário no histórico, pois contém deliberadamente as sentinelas sintéticas. Ele continua sujeito às assinaturas de alta confiança e a exclusão aparece no resumo sanitizado.

## Severidade, estado e prioridade

- `CRITICAL`: comprometimento amplo ou imediato; prioridade P1.
- `HIGH`: impacto grave e explorável; prioridade P2.
- `MEDIUM`: impacto relevante com condições adicionais; prioridade P3.
- `LOW`: hardening ou impacto limitado; prioridade P4.
- `INFO`: contexto ou não aplicabilidade; prioridade P4 quando convertido em issue.
- `STRENGTH`: controle positivo comprovado; não é finding nem altera o gate.

Estados: `OPEN`, `ACCEPTED`, `FIXED` e `NOT_APPLICABLE`. Somente findings `OPEN` com severidade `CRITICAL` ou `HIGH` bloqueiam `security:audit:gate`. A geração dos artefatos nunca é bloqueada por severidade.

## Contrato dos dados

`findings.json` usa `schemaVersion: 1` e contém as coleções `findings` e `strengths`. Todo finding inclui ID, título, categoria, severidade, estado, controle, arquivo, linhas, trecho mascarado, descrição, impacto, explorabilidade, condições, remediação, critérios de aceite, verificação, labels, issue Markdown e caminhos de evidência. Strengths possuem evidência equivalente sem representar vulnerabilidade.

Issues completas usam os delimitadores literais `--- ISSUE n ---` e `--- FIM ISSUE n ---`, com numeração determinística. O relatório final usa o título exato “Relatório de Auditoria de Segurança — JRC WhatsApp Broker” e a paleta aprovada; sua geração e validação visual pertencem à etapa PDF separada.

O verificador de PDF usa `pdfinfo` e `pdftoppm`: confirma A4, rasteriza todas as páginas em PNG a 150 DPI, compara a quantidade de imagens com o page count e valida no arquivo real o cabeçalho e a paginação da página 2 em diante. A inspeção humana final percorre todos os PNGs para excluir cortes, sobreposições, páginas inesperadamente vazias e divergências visuais.

## Sanitização e reprodutibilidade

Nenhum achado inclui valor detectado ou trecho bruto. Fingerprints usam HMAC-SHA-256 com segredo fornecido somente por ambiente. O scanner rejeita segredo ausente ou curto. Ordenação de rotas e achados é determinística; timestamps versionados derivam de `SOURCE_DATE_EPOCH` na etapa de geração integral.

O histórico Git é lido apenas no repositório JRC e exclui `upstream/evolution-api` antes da leitura de blobs. Bundles incluem somente `apps/api/dist/**` e `packages/{contracts,providers,security}/dist/**`, sem `node_modules`, source maps ou upstream.
