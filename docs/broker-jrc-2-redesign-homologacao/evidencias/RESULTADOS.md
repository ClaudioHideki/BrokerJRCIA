# Evidências do incremento A — 30/10/2026

## Escopo e origem

Base d1b66a; branch `codex/broker-jrc-2-redesign-homologacao-20261030`. Este arquivo documenta o piloto local de `/operations/health`, não a homologação integral do Broker. As evidências herdadas em `baseline-20261030/` conservam a data e o escopo originais.

## Testes executados

- **TDD inicial:** seis testes de página falharam antes da implementação, incluindo consulta concorrente, resposta obsoleta e quebra por resposta inválida. A fixture de demo também retornou 404 antes de ser implementada.
- **Seleção final:** cinco arquivos / **26 testes aprovados**, zero falhas, 8,43s. Inclui página (8), modelo (8), demo (1), tokens (3) e serviço de observabilidade (6). Log: `piloto-testes.log`.
- **Conferência antes do commit local:** `npm test --` com esses cinco arquivos e `App.test.tsx`: **6 arquivos / 32 testes aprovados**, 10,11s (`pre-commit-testes.log`). Seleção sobreposta, não somar à regressão geral.
- **Typecheck:** `tsc -b --pretty false`, exit 0 após os ajustes de timeout e clock skew. Log sem diagnósticos: `typecheck.log`.
- **Build:** `npm run build:web`, exit 0. Aviso preexistente de anotação PURE em Zod; nenhuma dependência alterada. `build-web.log`.
- **Bundle:** scanner de produção, 32 arquivos, findings vazio. `bundle-security.log`. Demo continua sob import DEV; não é um bypass de autenticação produtiva.
- **Compose:** dois arquivos / sete testes aprovados, 20,38s, somente renderização com ENV sintética. `compose-config.log`. Não iniciou containers nem acessou banco.
- **Lint:** não existe script lint no package.json raiz. Não declarar lint aprovado. `git diff --check` é apenas conferência de whitespace, não substitui lint.
- **Regressão frontend:** 104 arquivos, 748 testes aprovados/1 falha na primeira execução (346,26s). A falha era a asserção antiga de `App.test.tsx`, que esperava chamada sem AbortSignal e o texto anterior. Corrigida; reteste do arquivo: **6/6 aprovados**, 17,37s (`app-regressao-final.log`). Não somar os seis aos 749: há sobreposição.
- **Regressão geral sem os dois arquivos Compose:** 464 arquivos; **3 suites com falha, 461 aprovadas; 3.606 testes aprovados, 2 falhas e 4 não executados**, 477,25s (`regressao-sem-docker.log`). As duas falhas de teste foram App acima e timeout30s em geração de artefatos de segurança. Reteste isolado dos artefatos: **6/6 aprovados**, 96,85s (`security-artifacts-retest.log`), sem aumentar timeout ou mudar o gerador.
- **Pendência concreta de teste:** `chatwoot-safe-http-socket.test.ts` falhou no setup por `spawnSync openssl ENOENT`; seus quatro casos TLS não foram executados. OpenSSL não foi localizado no PATH ou caminhos usuais verificados. Não são quatro PASS nem uma regressão de produto comprovada. Exigem ambiente com OpenSSL e nova execução.
- **Primeira tentativa geral:** interrompida sem conclusão; tinha Git ausente do PATH. O teste upstream isolado passou após acrescentar o Git instalado ao PATH. O log original foi conservado como tentativa, não como resultado final.

**A suíte geral ainda não pode ser declarada totalmente verde:** restam quatro testes TLS sem execução. A nova interface tem evidência local suficiente para revisão do incremento, não para liberação integral de produção.

## Revisão independente

Dois P2 foram encontrados e corrigidos: request pendurado congelava o single-flight; idade negativa de heartbeat por diferença de relógio invalidava o snapshot completo. Agora há deadline 20s/AbortController/Promise.race e aceitação de idade assinada com orientação visível. Contagens negativas continuam inválidas. Após releitura, nenhum achado acionável restante no piloto.

A troca normal de empresa remonta o Outlet por organizationId, e o cliente invalida respostas antigas. O teste local troca o cliente; não deve ser descrito como jornada produtiva de tenant switch.

## Verificação visual e acessibilidade

Preview `http://127.0.0.1:5211/operations/health?demo=1` com banner de dados simulados. Testado tema claro, escuro e viewport 390×844. Largura da página observada 375px, região do piloto 343px, viewport390px: sem overflow horizontal nessa conferência. Override removido depois do teste.

Um conflito com `.console-shell h2/h3` foi encontrado visualmente e corrigido com seletores de tema limitados ao piloto. Capturas finais: `piloto-claro.jpg`, `piloto-escuro.jpg`, `piloto-mobile.jpg`.

Axe/jsdom sem violações na região; regra color-contrast desativada porque jsdom não faz layout real. Inspeção visual não equivale a auditoria WCAG completa. Não foi testado leitor de tela nem teclado integral.

## Infraestrutura não homologada neste incremento

O Docker negou acesso no sandbox inicialmente. A consulta elevada `docker info --format '{{.ServerVersion}}'` respondeu **29.5.2**. A indisponibilidade inicial não deve continuar sendo apresentada como absoluta. Os ensaios integrados PG/Redis/MinIO, restart, restore, engine efetiva e benchmark ainda não foram executados nesta etapa. O runner MinIO de CI exige Linux amd64; o host atual é Windows. Sete testes de Compose não provam funcionamento desses serviços.

## Compatibilidade e produção

Nenhuma mudança em API, auth, scopes, contratos públicos, migrations, Compose, ENV ou dados reais. Nenhuma publicação, merge, push, replay ou mensagem. Este piloto só lê a API existente. A saúde SQL histórica, retry Evolution, custódia física, fairness e capacidade continuam pendências de outros incrementos.

## Arquivos de implementação

- `apps/web/src/pages/OperationalHealth.tsx` e teste.
- `apps/web/src/app/App.test.tsx`: asserção de integração atualizada para o cancelamento e novo texto.
- `apps/web/src/operations/health-model.ts`, teste, `useOperationalHealth.ts`, `health.css`.
- `apps/web/src/broker/demo.ts`, `demo-health.test.ts`.
- `packages/ui/src/tokens.ts`, `index.ts`.
- Vinte documentos e evidências nesta pasta. Nenhuma migration criada.
