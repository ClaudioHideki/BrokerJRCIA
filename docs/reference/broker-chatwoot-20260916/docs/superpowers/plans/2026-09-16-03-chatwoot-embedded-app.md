# Chatwoot externo: Dashboard App seguro - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar QR e estado em painel incorporado para terceiros, preservando portal autônomo e autenticação própria.

**Architecture:** Uma página limitada do broker e incorporavel somente pela origem aprovada. Autorização first-party emite sessão curta por inbox; contexto postMessage não autentica ninguem.

**Tech Stack:** React/Vite, Fastify, PostgreSQL/RLS, WebCrypto/node:crypto, Vitest e Playwright do broker.

**Spec:** `docs/superpowers/specs/2026-09-16-broker-chatwoot-integration-design.md`

## Global Constraints

- Ler a especificação inteira e o AGENTS.md do repositório antes da primeira alteração.
- Não fazer push, merge, publicação de imagens ou deploy. Não alterar a main nem recursos reais.
- Preservar `Channel::Api`, webhook por inbox, engine privado, isolamento tenant e transporte existente.
- Uma organização corresponde a uma conta Chatwoot neste incremento.
- Segredos permanentes ficam no servidor; QR temporário somente em memoria da tela autorizada.
- Novos endpoints, tipos e arquivos abaixo são propostas para implementar, não APIs atualmente disponíveis.
- Cada tarefa: teste RED, implementação mínima, teste GREEN, regressão e commit local focado.
- Ranges de linha podem mudar; localizar símbolos antes de editar. Não sobrescrever arquivos por inteiro.
- Banco/Redis de testes isolados. Credenciais somente pelo mecanismo seguro do ambiente.
- Resultados locais não equivalem a homologação remota ou piloto com telefone.

---

## Dependências e mapa

Raiz: `ClaudioHideki/BrokerJRCIA`. Depende de B7; não exige que o cliente instale o código do plano 02. Clientes sem Dashboard Apps continuam usando portal. Branch/worktrees derivados da branch de integração `codex/broker-chatwoot-control`, sem duas tarefas editarem o mesmo arquivo simultaneamente.

Criar modulo `apps/api/src/modules/integrations/embed/` para app, autorizações/sessões e política de frame. Criar `apps/web/src/embed/` para página limitada e handshake. Reservar `0021_chatwoot_embed.sql`, ou próximo ordinal livre no momento da execução. Essa migração não armazena QR nem segredo administrativo do Chatwoot.

Adicao de arquivos abaixo não implica liberar todo o React App para iframe; o entrypoint deve escolher superficie restrita, sem menus/admin/rotas da console.

## Tarefa E1: Registro do app e sessão limitada

**Arquivos e responsabilidades:**
- Criar `apps/api/src/modules/integrations/embed/apps.ts`, `authorization.ts`, `session.ts` e `repository.ts`.
- Criar `apps/api/src/http/routes/chatwoot-embed.ts` e migração `0021_chatwoot_embed.sql`; atualizar app.ts/RLS/rotas/OpenAPI.
- Criar `packages/contracts/src/integrations/embed.ts` e testes `apps/api/tests/unit/chatwoot-embed-auth.test.ts`, `apps/api/tests/integration/chatwoot-embed-auth.test.ts`.

**Interfaces:**
Produz `verifyEmbedProof(verifier, challenge): boolean`; `EmbedAuthorizationService.start(embedId,challenge)`, `.approve(principal,requestId,integrationIds)`, `.exchange(requestId,verifier)`.
Tabelas: `chatwoot_embed_apps` (embedId/org/conta/revisão), `chatwoot_embed_authorizations` (requestId/desafio/aprovação/expiração/consumo), `chatwoot_embed_sessions` (hash token/usuário/org/grants/revisão/expiração).
Rotas: POST `/v1/integrations/chatwoot/embed-apps` (admin); POST `/v1/embed/authorizations`; POST `/v1/embed/authorizations/:id/approve` (login/CSRF); POST `/v1/embed/authorizations/:id/exchange`; GET `/v1/embed/connections/:id/status`; POST `/v1/embed/connections/:id/pair`.

- [ ] **Passo 1 - adicionar o teste de contrato/regressão abaixo no arquivo de teste indicado.** Complementar com os cenários de aceite da tarefa. Os imports novos apontam para símbolos produzidos nesta tarefa.

```typescript
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { verifyEmbedProof } from '../../src/modules/integrations/embed/authorization.js';
it('exige prova da solicitacao correta', () => {
  const verifier = 'v'.repeat(64);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  expect(verifyEmbedProof(verifier, challenge)).toBe(true);
  expect(verifyEmbedProof('other'.repeat(16), challenge)).toBe(false);
});
```

- [ ] **Passo 2 - executar RED e registrar a falha específica da funcionalidade ausente.** Falta de dependência/banco e bloqueio de ambiente, não evidência RED da regra.

```bash
npm test -- apps/api/tests/unit/chatwoot-embed-auth.test.ts
```

- [ ] **Passo 3 - implementar as mudancas definidas a seguir.**


```typescript
const expected = createHash('sha256').update(verifier).digest();
const received = Buffer.from(challenge, 'base64url');
return received.length === expected.length && timingSafeEqual(expected, received);
```

Implementar validação estrita base64url/comprimento e erro neutro; usar aleatoriedade criptográfica. start retorna requestId público e expiração de 120s, não uma sessão autenticada. Aprovacao exige login Broker e grant/conta atual, confirma usuário e recursos. Exchange consome atomicamente uma aprovação ainda valida e retorna token opaco de 5min, armazenado somente como hash. Prova/secret não vai em URL.

Rate limiting: start limitado por IP e embedId (10/min como política inicial); exchange pendente não mais que 1/s por requestId, com limite de falhas; não registrar verifier nem token. Sessão verifica usuário/empresa/grant/revisão a cada mutacao. Aceita apenas state/pair, não endpoints legados nem disconnect. lookup público de embedId retorna somente metadados minimos para inicializacao, nunca dados da conta.

- [ ] **Passo 4 - executar novamente o comando, conferir GREEN e realizar os critérios adicionais.**

PostgreSQL real: dois exchanges concorrentes resultam em exatamente uma emissão; expiração/aprovação negada/prova incorreta não criam sessão. Token de app A não acessa B. Revogar grant/chave de integração/suspender empresa inválida a próxima operação. Sessão de iframe não envia mensagens e não cria instâncias. Testar troca de destino e de identidade aprovada.

- [ ] **Passo 5 - revisar diff, conferir secrets e registrar commit local.** Fazer stage somente dos arquivos desta tarefa, sem `git add .`.

```bash
git diff --check
git diff --cached --check
git commit -m "feat(chatwoot-embed): add constrained authorization sessions"
```

## Tarefa E2: Pagina incorporavel e cabeçalhos isolados

**Arquivos e responsabilidades:**
- Criar `apps/api/src/modules/integrations/embed/frame-policy.ts`.
- Modificar `infra/web/server.mjs` e `apps/web/src/app/App.tsx` apenas nos pontos de roteamento; criar `apps/web/src/embed/EmbedPage.tsx`.
- Criar `apps/api/tests/unit/chatwoot-frame-policy.test.ts`; ampliar `tests/web-runtime.test.mjs` e testes de headers.

**Interfaces:**
Produz `buildEmbedHeaders(approvedOrigin: string): Record<string,string>` e endpoint de metadados públicos `/v1/embed/apps/:embedId/policy`, sem credenciais/dados privados.
Servidor web resolve somente o embedId contra API interna fixa e monta HTML do bundle restrito com CSP de origem aprovada. Não buscar URL arbitrária recebida na query. Falha/ID inválido resulta página bloqueada.

- [ ] **Passo 1 - adicionar o teste de contrato/regressão abaixo no arquivo de teste indicado.** Complementar com os cenários de aceite da tarefa. Os imports novos apontam para símbolos produzidos nesta tarefa.

```typescript
import { expect, it } from 'vitest';
import { buildEmbedHeaders } from '../../src/modules/integrations/embed/frame-policy.js';
it('restringe o ancestor e nao inclui XFO conflitante', () => {
  const h = buildEmbedHeaders('https://client.example.com');
  expect(h['Content-Security-Policy']).toContain("frame-ancestors https://client.example.com");
  expect(h['X-Frame-Options']).toBeUndefined();
  expect(h['Cache-Control']).toBe('no-store');
});
```

- [ ] **Passo 2 - executar RED e registrar a falha específica da funcionalidade ausente.** Falta de dependência/banco e bloqueio de ambiente, não evidência RED da regra.

```bash
npm test -- apps/api/tests/unit/chatwoot-frame-policy.test.ts tests/web-runtime.test.mjs
```

- [ ] **Passo 3 - implementar as mudancas definidas a seguir.**


```text
/embed/chatwoot/:embedId -> HTML limitado + frame-ancestors origem aprovada
/jrc, /login, /dashboard -> frame-ancestors none + X-Frame-Options DENY
/embed/authorize -> first-party somente, frame-ancestors none
```

CSP em HTTP header real, não meta tag. Preservar default-src/script-src/img-src/connect-src restritos ao que a página precisa. Não expor tela Meta, admin ou todas as rotas React no embed. Excluir QR/auth da cache do browser, proxy/CDN e service worker.

Implementar diferenca entre frame-src (o que pode ser carregado pela página) e frame-ancestors (quem pode incorpora-la). Permitir apenas origem completa aprovada, sem wildcard global. Se destino revogado, negar policy e sessão. Metadata publicamente consultavel nunca inclui QR, token, accountId ou lista de usuários.

Validar também os cabeçalhos do proxy final: XFO DENY herdado na rota embed quebraria o fluxo; remover apenas nessa rota, manter em todas as outras.

- [ ] **Passo 4 - executar novamente o comando, conferir GREEN e realizar os critérios adicionais.**

Teste de navegador com origem permitida e outra não permitida. Confirmar /jrc impossivel de incorporar e alteração de embedId não herda header/cache de outra empresa. Testar revogação do destino e backend de policy indisponivel. Flags desligadas mantem bloqueio total de iframe.

- [ ] **Passo 5 - revisar diff, conferir secrets e registrar commit local.** Fazer stage somente dos arquivos desta tarefa, sem `git add .`.

```bash
git diff --check
git diff --cached --check
git commit -m "feat(chatwoot-embed): isolate allowed framing surface"
```

## Tarefa E3: Autorização first-party e contexto não confiável

**Arquivos e responsabilidades:**
- Criar `apps/web/src/embed/AuthorizePage.tsx`, `useEmbedSession.ts`, `context.ts`, `context.test.ts` e testes do handshake.
- Modificar roteamento explicitamente para `/embed/authorize`; reutilizar página/login/sessão do portal sem expor suas credenciais ao iframe.
- Conectar EmbedPage a rotas state/pair de E1; não usar token administrativo do cliente.

**Interfaces:**
Produz `isAllowedContextEvent({origin, sourceIsParent}, expectedOrigin): boolean`; parser de appContext restrito a IDs necessários.
Sessão em memoria expira em 5min. A página de aprovação le requestId público, mostra conta/inboxes/ações a conceder e aprova pelo backend autenticado. postMessage só notifica mudanca/contexto; não entrega token ou QR.

- [ ] **Passo 1 - adicionar o teste de contrato/regressão abaixo no arquivo de teste indicado.** Complementar com os cenários de aceite da tarefa. Os imports novos apontam para símbolos produzidos nesta tarefa.

```typescript
import { expect, it } from 'vitest';
import { isAllowedContextEvent } from './context.js';
it('rejeita origem e janela distintas', () => {
  expect(isAllowedContextEvent({origin:'https://evil.example',sourceIsParent:true},
    'https://client.example.com')).toBe(false);
  expect(isAllowedContextEvent({origin:'https://client.example.com',sourceIsParent:false},
    'https://client.example.com')).toBe(false);
});
```

- [ ] **Passo 2 - executar RED e registrar a falha específica da funcionalidade ausente.** Falta de dependência/banco e bloqueio de ambiente, não evidência RED da regra.

```bash
npm test -- apps/web/src/embed
```

- [ ] **Passo 3 - implementar as mudancas definidas a seguir.**


```typescript
export const isAllowedContextEvent = (
  event: {origin:string; sourceIsParent:boolean}, expectedOrigin:string
): boolean => event.sourceIsParent && event.origin === expectedOrigin;
```

Criar desafio com WebCrypto e abrir aprovação em ação explícita do usuário, sem popup automático. Polling de exchange depende do verifier local e requestId; não depende de cookies de terceiros. Troca gera token somente após aprovação; token e mantido em ref/memoria e usado no Authorization das rotas embed. Não gravar tokens em URL/localStorage/sessionStorage/DOM.

No parent context, ignorar currentAgent como identidade e usar apenas IDs que pertencem a concessão. Se contexto não corresponder ao destino/conta, limpar selecao e negar acesso. Não armazenar payload inteiro de conversa/contato no broker para operar QR.

UI apresenta link first-party do portal quando popup/iframe não funciona ou usuário prefere portal. Esse caminho continua exigindo login; não e bypass por magic link. A expiração encerra acesso e remove QR; estado da sessão WhatsApp no engine continua independente.

- [ ] **Passo 4 - executar novamente o comando, conferir GREEN e realizar os critérios adicionais.**

Testar cookies de terceiros bloqueados, popup negado, sessão expirada, outra empresa selecionada no portal, tentativa de autorizar requestId errado e troca de conversa. Uma simples mensagem postMessage com papel administrator não cria permissão. Checar nenhum secret no parent/URL/telemetria.

- [ ] **Passo 5 - revisar diff, conferir secrets e registrar commit local.** Fazer stage somente dos arquivos desta tarefa, sem `git add .`.

```bash
git diff --check
git diff --cached --check
git commit -m "feat(chatwoot-embed): implement verified browser authorization"
```

## Tarefa E4: Provisionamento opcional do Dashboard App e portal completo

**Arquivos e responsabilidades:**
- Modificar `apps/api/src/modules/integrations/chatwoot-client.ts` com listagem/criação de Dashboard App por capacidades verificadas.
- Modificar `apps/web/src/integrations/ChatwootPanel.tsx` para gerar nome/URL e opcionalmente instalar app.
- Criar `apps/api/tests/unit/chatwoot-dashboard-app.test.ts` e componente/testes de instalação.
- Atualizar `docs/operations/chatwoot-external.md`.

**Interfaces:**
Produz `buildDashboardAppPayload(title,url)` e métodos `listDashboardApps(accountId)`/`createDashboardApp(accountId,input)` quando o destino suporta o contrato. Auto-instalação não e requisito para transporte.
App e por conta; `embedId` não e credencial. Repeticao reconcilia por URL exata do app, não só pelo titulo.

- [ ] **Passo 1 - adicionar o teste de contrato/regressão abaixo no arquivo de teste indicado.** Complementar com os cenários de aceite da tarefa. Os imports novos apontam para símbolos produzidos nesta tarefa.

```typescript
import { expect, it } from 'vitest';
import { buildDashboardAppPayload } from '../../src/modules/integrations/embed/apps.js';
it('usa payload confirmado no fork, sem credencial na URL', () => {
  expect(buildDashboardAppPayload('Conexoes JRC','https://broker.example.com/embed/chatwoot/public-id'))
    .toEqual({dashboard_app:{title:'Conexoes JRC',content:[{
      type:'frame',url:'https://broker.example.com/embed/chatwoot/public-id'
    }]}});
});
```

- [ ] **Passo 2 - executar RED e registrar a falha específica da funcionalidade ausente.** Falta de dependência/banco e bloqueio de ambiente, não evidência RED da regra.

```bash
npm test -- apps/api/tests/unit/chatwoot-dashboard-app.test.ts apps/web/src/integrations/ChatwootPanel.test.tsx
```

- [ ] **Passo 3 - implementar as mudancas definidas a seguir.**


```typescript
return { dashboard_app: { title, content: [{type:'frame',url}] } };
```

Validar URL gerada por origem própria do broker, não fornecida livremente pelo cliente. POST utiliza Application API do destino aprovado, sem Platform App. Não assumir endpoint disponível por mero número de versão; verificar no piloto/contract test.

Ao 403/404 de capacidade, informar indisponibilidade do cadastro automático e manter nome/URL para instalação manual quando o recurso existir. Não relaxar assinatura da caixa nem permissões. Timeout após criação de app e resultado incerto: listar/reconciliar por URL antes de repetir.

Portal precisa permitir conectar número, consultar QR, status e grants mesmo sem conversa ou Dashboard App. Evitar duplicar app a cada nova inbox; selecao dentro do app considera grants e contexto não confiável.

- [ ] **Passo 4 - executar novamente o comando, conferir GREEN e realizar os critérios adicionais.**

Testar repetição, timeout, app já existente, endpoint ausente, usuário sem permissão e app deletado no Chatwoot. As mensagens da inbox continuam funcionando quando app e removido. Documentar que app na conversa não insere botão no assistente nativo de caixas de um produto de terceiros.

- [ ] **Passo 5 - revisar diff, conferir secrets e registrar commit local.** Fazer stage somente dos arquivos desta tarefa, sem `git add .`.

```bash
git diff --check
git diff --cached --check
git commit -m "feat(chatwoot-embed): provision optional dashboard app"
```

## Tarefa E5: Teste de navegador, isolamento e gate de distribuição

**Arquivos e responsabilidades:**
- Criar `apps/web/tests/e2e/chatwoot-embed.spec.ts` com origem parent de laboratório.
- Criar `apps/web/tests/unit/embed-artifact-policy.test.ts` e ampliar política de artefatos sintéticos existente.
- Atualizar flags, inventário de rotas, OpenAPI e documentação de rollout/rollback.
- Preencher matriz de aceite do pacote com resultados e bloqueios reais.

**Interfaces:**
Produz funcao `sanitizeEmbedDiagnostic(value)` que permite apenas IDs de request/estado/código de erro e remove campos QR/token/verifier. Não e defesa única: logs não devem receber payload secreto na origem. Testes E2E usam somente credenciais e QR sintéticos.

- [ ] **Passo 1 - adicionar o teste de contrato/regressão abaixo no arquivo de teste indicado.** Complementar com os cenários de aceite da tarefa. Os imports novos apontam para símbolos produzidos nesta tarefa.

```typescript
import { expect, it } from 'vitest';
import { sanitizeEmbedDiagnostic } from '../../src/modules/integrations/embed/session.js';
it('nao inclui credenciais em diagnosticos', () => {
  const safe = sanitizeEmbedDiagnostic({requestId:'synthetic-request',status:'EXPIRED',
    token:'secret-token',verifier:'secret-proof',qr:'secret-qr'});
  expect(JSON.stringify(safe)).not.toMatch(/secret-token|secret-proof|secret-qr/);
  expect(safe.requestId).toBe('synthetic-request');
});
```

- [ ] **Passo 2 - executar RED e registrar a falha específica da funcionalidade ausente.** Falta de dependência/banco e bloqueio de ambiente, não evidência RED da regra.

```bash
npm test -- apps/api/tests/unit/chatwoot-embed-auth.test.ts apps/web/tests/unit/embed-artifact-policy.test.ts
```

- [ ] **Passo 3 - implementar as mudancas definidas a seguir.**


```typescript
return {requestId: value.requestId, status: value.status, code: value.code};
```

Adicionar o teste acima a `apps/api/tests/unit/chatwoot-embed-auth.test.ts`; a política de artefatos complementa a sanitizacao. E2E de navegador deve cobrir app permitido/bloqueado, login first-party, exchange único, pair, expirar, revogar grant e fallback portal. A suite usa contexto sem cookies de terceiros para provar que o desenho não depende deles.

Revisão final da superficie: routes auth públicas são limitadas, nenhum iframe acessa admin, nenhum controller aceita tenant remoto sem vinculo e nenhum token limitado funciona na API de mensageria. Feature embed desligada remove apenas app/handshake, sem derrubar transporte nem portal de conexões.

Flags novas não são habilitadas automaticamente em produção. Manter o plano de rollback de binario antigo distinto do desligamento de feature.

- [ ] **Passo 4 - executar novamente o comando, conferir GREEN e realizar os critérios adicionais.**

Executar Playwright, suite completa Broker, integration com PostgreSQL/Redis, build e scanner de bundle. Em piloto real, desabilitar traces/screenshots contendo QR/credenciais; anexar somente registros sanitizados. Declarar separado: contrato local, Chatwoot remoto, telefone autorizado. Ausência de um desses ambientes não pode ser contada como sucesso.

- [ ] **Passo 5 - revisar diff, conferir secrets e registrar commit local.** Fazer stage somente dos arquivos desta tarefa, sem `git add .`.

```bash
git diff --check
git diff --cached --check
git commit -m "test(chatwoot-embed): validate isolation and rollout"
```

## Gate do plano 03

```bash
npm run build
npm run typecheck
npm test
npm run test:integration
npm run test:e2e -- apps/web/tests/e2e/chatwoot-embed.spec.ts
npm run test:web:bundle
npm run openapi:generate
npm run security:contracts
npm run security:notices
npm run security:submodule
git diff --check
```

Após revisar/versionar contrato gerado, repetir geracao e exigir diff vazio. Testar os headers servidos pelo proxy final em homologação, não somente o helper unitario. Não declarar suporte universal a forks/edicoes sem capabilities e teste remoto.
