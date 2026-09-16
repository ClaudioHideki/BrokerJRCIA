# Broker: destinos externos e API de controle - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Habilitar o conector existente para diferentes instalações e fornecer controle de conexões seguro para o Rails e o portal.

**Architecture:** Manter as rotas legadas e o pipeline de mensagens. Acrescentar destino aprovado por tenant, fachada de controle e onboarding persistente.

**Tech Stack:** TypeScript, Fastify, Zod, Drizzle, PostgreSQL/RLS, Redis, React/Vite, Vitest; versões do lockfile.

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

## Preparação e mapa de arquivos

Raiz deste plano: checkout de `ClaudioHideki/BrokerJRCIA`. Ler `README.md`, `AGENTS.md`, `PLANO-MESTRE-JRC-BROKER-v2.md`, documentação de integração e `VALIDACAO-INTEGRACOES-20260915.md`. Comparar o HEAD real com o baseline da especificação sem descartar alterações.

```bash
git status --short
git rev-parse HEAD
git submodule status
node --version
npm --version
npm ci
npm run typecheck
npm test -- apps/api/tests/unit/chatwoot-client.test.ts apps/api/tests/unit/chatwoot-security.test.ts apps/api/tests/unit/integration-runtime.test.ts
```

Instalar dependências no ambiente isolado conforme AGENTS. O Node exigido pelo package.json consultado e `24.19.0`; não atualizar runtime/lockfiles sem necessidade documentada. Worktree/branch local proposta: `codex/broker-chatwoot-control`; worktrees por tarefa podem derivar dela. O executor deve usar a skill de worktrees no momento de implementar.

Criar novas responsabilidades em `modules/integrations/`: `chatwoot-destination.ts`, `chatwoot-safe-http.ts`, `chatwoot-context.ts`, `chatwoot-control-auth.ts`, `chatwoot-control-service.ts`, `chatwoot-onboarding.ts` e `chatwoot-health.ts`. Não concentrar tudo em `chatwoot-service.ts`.

Migrações seguintes reservadas neste baseline: `0018_chatwoot_destinations.sql`, `0019_chatwoot_control_auth.sql`, `0020_chatwoot_onboarding_operations.sql`. Conferir ultimo ordinal e journal antes de criar; se o HEAD novo já os usar, alocar os próximos sem editar migrações aplicadas.

## Tarefa B1: Modelo de destino, contratos e migração compatível

**Arquivos e responsabilidades:**
- Criar `apps/api/src/modules/integrations/chatwoot-destination.ts`: normalização e política de origem.
- Criar `apps/api/drizzle/migrations/0018_chatwoot_destinations.sql`; atualizar journal, RLS/grants e `apps/api/src/db/integrations-schema.ts`.
- Criar `packages/contracts/src/integrations/destinations.ts`; exportar por `packages/contracts/src/index.ts`.
- Criar `apps/api/tests/unit/chatwoot-destination.test.ts` e `apps/api/tests/integration/chatwoot-destinations.test.ts`.
- Modificar `apps/api/src/http/routes/platform.ts`: aprovação administrativa por organização, seguindo o auth global existente.

**Interfaces:**
Produz `normalizeChatwootOrigin(value: string): string`, que lanca erro para origem rejeitada; e schema `DestinationRequestSchema = {baseUrl:string, mode:'MANAGED'|'EXTERNAL'}`.
Produz `ChatwootDestination` com `organizationId`, `baseUrl`, `mode`, `approvalStatus`, `mediaOrigins`, `revision`. O mode não concede privilegio por si: MANAGED exige origem global registrada.
Rotas novas: `PUT /v1/integrations/chatwoot/destination` (solicitacao do admin do tenant) e `POST /v1/platform/organizations/:id/chatwoot/destination/approve` (administracao JRC). Nenhuma recebe token Chatwoot.

- [ ] **Passo 1 - adicionar o teste de contrato/regressão abaixo no arquivo de teste indicado.** Complementar com os cenários de aceite da tarefa. Os imports novos apontam para símbolos produzidos nesta tarefa.

```typescript
import { describe, expect, it } from 'vitest';
import { normalizeChatwootOrigin } from '../../src/modules/integrations/chatwoot-destination.js';
describe('Chatwoot destination', () => {
  it('normaliza uma origem sem alterar o hostname', () => {
    expect(normalizeChatwootOrigin('https://Atendimento.Example.com/'))
      .toBe('https://atendimento.example.com');
  });
  it.each(['http://example.com', 'https://u:p@example.com',
    'https://example.com/app', 'https://example.com/?token=x',
    'https://example.com/#x', 'https://example.com:8443'])('rejeita %s', value => {
    expect(() => normalizeChatwootOrigin(value)).toThrow();
  });
});
```

- [ ] **Passo 2 - executar RED e registrar a falha específica da funcionalidade ausente.** Falta de dependência/banco e bloqueio de ambiente, não evidência RED da regra.

```bash
npm test -- apps/api/tests/unit/chatwoot-destination.test.ts
```

- [ ] **Passo 3 - implementar as mudancas definidas a seguir.**


```typescript
const u = new URL(value);
if (u.protocol !== 'https:' || u.username || u.password || u.search ||
    u.hash || u.pathname !== '/' || (u.port && u.port !== '443')) {
  throw new Error('INVALID_CHATWOOT_ORIGIN');
}
// Aplicar a validacao de hostname/IP da politica de destino antes do return.
return u.origin;
```

A normalização não e o controle SSRF completo; B2 implementa a validação no socket. Criar a tabela definida na especificação e backfill a partir de contas existentes, sem ler nem reescrever os tokens. Contas legadas ficam MANAGED com origem preservada; estado de verificação não e promovido sem evidência. Adicionar versões e capacidades a `chatwoot_accounts`. A aprovação deve registrar ator/data e ser acessível somente pelo guard administrativo existente. Uma empresa não aprova seu próprio destino externo.

Estender schema/SQL e concessões tenant conjuntamente. Conta READY com origem diferente do destino e erro. Mudanca de destino em uso retorna `DESTINATION_IN_USE`; rotação de token da mesma conta permanece permitida.

- [ ] **Passo 4 - executar novamente o comando, conferir GREEN e realizar os critérios adicionais.**

Integração PostgreSQL: duas empresas podem ter `account_id=1` em origens diferentes; mesma origem/conta não pode ter dois donos. Empresa A não le nem altera destino da B. Backfill preserva ciphertext e IDs existentes. Testar instalação limpa e upgrade a partir de banco na migração 0017. Executar `npm run test:integration -- apps/api/tests/integration/chatwoot-destinations.test.ts`.

- [ ] **Passo 5 - revisar diff, conferir secrets e registrar commit local.** Fazer stage somente dos arquivos desta tarefa, sem `git add .`.

```bash
git diff --check
git diff --cached --check
git commit -m "feat(chatwoot): add tenant approved destinations"
```

## Tarefa B2: Transporte HTTP com destino aprovado e DNS fixado

**Arquivos e responsabilidades:**
- Criar `apps/api/src/modules/integrations/chatwoot-safe-http.ts`.
- Modificar `apps/api/src/modules/integrations/chatwoot-client.ts`: usar transporte injetavel seguro para API e mídia.
- Criar `apps/api/tests/unit/chatwoot-safe-http.test.ts`; ampliar `chatwoot-client.test.ts` e `media-integration.test.ts`.

**Interfaces:**
Produz `assertPublicAddresses(addresses: readonly string[]): void` e `createChatwootSafeFetch({origin, resolve, connect}): typeof fetch`.
`resolve(host)` retorna A/AAAA; `connect` recebe hostname/SNI original e `approvedAddresses` para estabelecer somente IP validado. Implementação de produção usa node:https; mocks não constituem validação de socket.

- [ ] **Passo 1 - adicionar o teste de contrato/regressão abaixo no arquivo de teste indicado.** Complementar com os cenários de aceite da tarefa. Os imports novos apontam para símbolos produzidos nesta tarefa.

```typescript
import { expect, it } from 'vitest';
import { assertPublicAddresses } from '../../src/modules/integrations/chatwoot-safe-http.js';
it.each(['127.0.0.1','10.0.0.1','169.254.169.254','0.0.0.0',
  '::1','::','fc00::1','fe80::1','::ffff:127.0.0.1'])('bloqueia %s', ip => {
  expect(() => assertPublicAddresses([ip])).toThrow();
});
it('nao aceita resposta DNS mista', () => {
  expect(() => assertPublicAddresses(['8.8.8.8','10.0.0.1'])).toThrow();
});
```

- [ ] **Passo 2 - executar RED e registrar a falha específica da funcionalidade ausente.** Falta de dependência/banco e bloqueio de ambiente, não evidência RED da regra.

```bash
npm test -- apps/api/tests/unit/chatwoot-safe-http.test.ts
```

- [ ] **Passo 3 - implementar as mudancas definidas a seguir.**


```typescript
const addresses = await resolve(target.hostname);
assertPublicAddresses(addresses);
return connect({ target, approvedAddresses: addresses,
  servername: target.hostname, rejectUnauthorized: true, redirect: 'error' });
```

Esse trecho define a ordem de operações, não dispensa a implementação do conector HTTPS. O lookup usado por node:https precisa devolver o IP aprovado, sem segunda resolução independente. Criar classificação IPv4/IPv6 usando primitives de rede e lista completa de redes especiais, não somente os exemplos do teste. Rejeitar literais codificados que normalizam para IP bloqueado. Preservar limite de resposta, timeout, cancelamento, FormData e política de resultados incertos do cliente existente.

Toda URL de anexo deve ser autorizada pelo registro remoto e pela allowlist tenant. Credencial de API fica restrita a origem Chatwoot. CDN recebe somente o necessário para baixar o anexo; não herda headers autenticados.

- [ ] **Passo 4 - executar novamente o comando, conferir GREEN e realizar os critérios adicionais.**

Adicionar testes de redirect 301/302, DNS rebinding entre verificação e conexão, IPv6 mapeado, certificado TLS inválido, timeout e tamanho excedido. Um teste com servidor de laboratório deve provar que o IP efetivamente conectado e o validado; nenhum teste contata infraestrutura de terceiros. Executar regressão dos clientes e mídia existentes.

- [ ] **Passo 5 - revisar diff, conferir secrets e registrar commit local.** Fazer stage somente dos arquivos desta tarefa, sem `git add .`.

```bash
git diff --check
git diff --cached --check
git commit -m "feat(chatwoot): enforce safe outbound transport"
```

## Tarefa B3: Resolvedor tenant e portal para vincular instalações

**Arquivos e responsabilidades:**
- Criar `apps/api/src/modules/integrations/chatwoot-context.ts`.
- Modificar `chatwoot-service.ts`, `runtime.ts`, `chatwoot-worker.ts`, `chatwoot-provisioner.ts`, `apps/api/src/config/env.ts` e download de mídia.
- Modificar `packages/contracts/src/integrations/schemas.ts`, `apps/web/src/integrations/ChatwootPanel.tsx`, `infra/dokploy/.env.example` e Compose se necessário.
- Criar `apps/api/tests/unit/chatwoot-context.test.ts`; ampliar `integration-runtime.test.ts` e `ChatwootPanel.test.tsx`.

**Interfaces:**
Produz `resolveChatwootContext(transaction, organizationId)` e `mayUsePlatformToken({mode, origin, managedOrigin}): boolean`.
Contexto contem destino aprovado, revisão, conta e cliente server-side; nenhum DTO público inclui token. `bindAccount` conserva `{accountId,token}` e resolve o destino do tenant; clientes legados usam destino MANAGED default. API key de controle e outra credencial, criada em B4.

- [ ] **Passo 1 - adicionar o teste de contrato/regressão abaixo no arquivo de teste indicado.** Complementar com os cenários de aceite da tarefa. Os imports novos apontam para símbolos produzidos nesta tarefa.

```typescript
import { expect, it } from 'vitest';
import { mayUsePlatformToken } from '../../src/modules/integrations/chatwoot-context.js';
it('nao envia token de plataforma para cliente externo', () => {
  expect(mayUsePlatformToken({mode:'EXTERNAL', origin:'https://client.example.com',
    managedOrigin:'https://jrc.example.com'})).toBe(false);
});
it('exige origem gerenciada exata', () => {
  expect(mayUsePlatformToken({mode:'MANAGED', origin:'https://other.example.com',
    managedOrigin:'https://jrc.example.com'})).toBe(false);
});
```

- [ ] **Passo 2 - executar RED e registrar a falha específica da funcionalidade ausente.** Falta de dependência/banco e bloqueio de ambiente, não evidência RED da regra.

```bash
npm test -- apps/api/tests/unit/chatwoot-context.test.ts apps/api/tests/unit/integration-runtime.test.ts
```

- [ ] **Passo 3 - implementar as mudancas definidas a seguir.**


```typescript
export const mayUsePlatformToken = (v: {
  mode: 'MANAGED'|'EXTERNAL'; origin: string; managedOrigin: string|null;
}): boolean => v.mode === 'MANAGED' && v.origin === v.managedOrigin;
```

Substituir selecao global da origem em todos os caminhos de cliente, worker, download, retry e status pelo mesmo resolvedor. `configured` significa servico habilitado, não necessariamente conta vinculada. Tornar origem global opcional no runtime EXTERNAL sem retirar validações de publicOrigin/chave de cifra. Nunca inferir que existencia de chave de cifra exige uma origem global.

Portal: escolher JRC gerenciado ou próprio Chatwoot; solicitar/aprovar destino; validar conta/token; selecionar conexão/inbox/agentes. Campo de token write-only, não preenchido a partir de GET; rotação verifica credencial nova antes de substituir a antiga. Capabilities ausentes aparecem UNVERIFIED. Manter provisionamento de conta/responsável somente no MANAGED autorizado.

- [ ] **Passo 4 - executar novamente o comando, conferir GREEN e realizar os critérios adicionais.**

HTTP controlado com dois servidores diferentes e IDs remotos iguais: mensagens, anexos, retries e status usam o servidor correto. Validar runtime sem CHATWOOT_BASE_URL quando só existem externos. Preservar fluxo legado sem novo campo obrigatorio. Testar token revogado, origem pendente e versão de credencial atualizada. Nenhuma requisicao externa recebe o token de plataforma.

- [ ] **Passo 5 - revisar diff, conferir secrets e registrar commit local.** Fazer stage somente dos arquivos desta tarefa, sem `git add .`.

```bash
git diff --check
git diff --cached --check
git commit -m "feat(chatwoot): resolve remote accounts per tenant"
```

## Tarefa B4: Credencial restrita para backend e autorização de controle

**Arquivos e responsabilidades:**
- Criar `apps/api/src/modules/integrations/chatwoot-control-auth.ts` e `apps/api/src/http/routes/chatwoot-control.ts`.
- Criar migração `0019_chatwoot_control_auth.sql` e tabelas `chatwoot_control_bindings`, `chatwoot_operator_grants`.
- Modificar emissores/schemas de API keys, `apps/api/src/app.ts`, inventário de rotas e OpenAPI.
- Criar `apps/api/tests/unit/chatwoot-control-auth.test.ts`, `apps/api/tests/http/chatwoot-control.test.ts` e teste de RLS. Não mudar os guards legados para aceita-los indiscriminadamente.

**Interfaces:**
Produz `authorizeControlRequest({credential, binding, requestedOrganizationId, requiredScope}): boolean` e principal interno validado `ChatwootControlPrincipal`.
Produz endpoint de emissão `POST /v1/integrations/chatwoot/control-credentials`, exclusivo OWNER/ADMIN autenticado no portal. Escopos definidos na especificação; retorna chave uma única vez, binding e ID. Revogacao usa mecanismo existente e inválida o binding na mesma operação.
Concessoes para usuários externos restritos: `PUT /v1/integrations/chatwoot/connections/:id/operator-grants`, exclusivo OWNER/ADMIN; usuários devem ser membros atuais da organização.

- [ ] **Passo 1 - adicionar o teste de contrato/regressão abaixo no arquivo de teste indicado.** Complementar com os cenários de aceite da tarefa. Os imports novos apontam para símbolos produzidos nesta tarefa.

```typescript
import { expect, it } from 'vitest';
import { authorizeControlRequest } from '../../src/modules/integrations/chatwoot-control-auth.js';
it('rejeita outra empresa mesmo com escopo', () => {
  expect(authorizeControlRequest({
    credential:{organizationId:'org-a', scopes:['chatwoot:pair'], revoked:false},
    binding:{organizationId:'org-a', active:true, destinationRevision:1},
    requestedOrganizationId:'org-b', requiredScope:'chatwoot:pair'
  })).toBe(false);
});
it('instances:write nao equivale a permissao de integracao', () => {
  expect(authorizeControlRequest({
    credential:{organizationId:'org-a', scopes:['instances:write'], revoked:false},
    binding:{organizationId:'org-a', active:true, destinationRevision:1},
    requestedOrganizationId:'org-a', requiredScope:'chatwoot:manage'
  })).toBe(false);
});
```

- [ ] **Passo 2 - executar RED e registrar a falha específica da funcionalidade ausente.** Falta de dependência/banco e bloqueio de ambiente, não evidência RED da regra.

```bash
npm test -- apps/api/tests/unit/chatwoot-control-auth.test.ts apps/api/tests/http/chatwoot-control.test.ts
```

- [ ] **Passo 3 - implementar as mudancas definidas a seguir.**


```typescript
return !v.credential.revoked && v.binding.active &&
  v.credential.organizationId === v.binding.organizationId &&
  v.binding.organizationId === v.requestedOrganizationId &&
  v.credential.scopes.includes(v.requiredScope);
```

Acima esta o núcleo da verificação; completar com conta, revisão do destino, existencia/atividade tenant, recurso e concessão atual. Ler privilegio da fonte autoritativa a cada mutacao. Não confiar em claim de papel do corpo.

A fachada chama servicos internos após validação; se o InstanceService exigir contexto legado, adicionar contexto interno delegado tipado e sua revalidacao, sem forjar JWT nem dar instances:write a chave do Rails. As rotas genericas de instâncias devem continuar rejeitando essa chave limitada. Registrar ator de servico e usuário externo atribuido em campos separados na auditoria. Cifrar a chave apenas no consumidor Rails; no broker preservar armazenamento por hash/HMAC existente.

- [ ] **Passo 4 - executar novamente o comando, conferir GREEN e realizar os critérios adicionais.**

Testar chave revogada, binding em outra conta/tenant, token Chatwoot usado como credencial Broker, ausência de escopo, grant revogado, empresa suspensa e tentativa de chamar /v1/instances com chave limitada. Operador legado mantem semântica antiga; VIEWER só recebe pair na integração explicitamente concedida. OpenAPI não expoe secrets em exemplos.

- [ ] **Passo 5 - revisar diff, conferir secrets e registrar commit local.** Fazer stage somente dos arquivos desta tarefa, sem `git add .`.

```bash
git diff --check
git diff --cached --check
git commit -m "feat(chatwoot): add scoped control credentials"
```

## Tarefa B5: Onboarding idempotente persistente

**Arquivos e responsabilidades:**
- Criar `apps/api/src/modules/integrations/chatwoot-onboarding.ts` e migração `0020_chatwoot_onboarding_operations.sql`.
- Modificar `chatwoot-control.ts`, `runtime.ts` e `apps/api/src/commands/messaging-worker.ts` para processamento tenant-scoped.
- Criar `packages/contracts/src/integrations/control.ts`; exportar schemas de onboarding e status.
- Criar `apps/api/tests/unit/chatwoot-onboarding.test.ts` e `apps/api/tests/integration/chatwoot-onboarding.test.ts`.

**Interfaces:**
Consome OnboardingInput da especificação e principal de B4. Produz `OnboardingInputSchema`, `OnboardingOperationSchema`, `OnboardingService.start(principal,input,key)` e `.get(principal,id)`.
Produz operação persistida e mapeamento existente: instance -> messaging channel -> chatwoot connection -> inbox. Não acrescentar transporte alternativo.

- [ ] **Passo 1 - adicionar o teste de contrato/regressão abaixo no arquivo de teste indicado.** Complementar com os cenários de aceite da tarefa. Os imports novos apontam para símbolos produzidos nesta tarefa.

```typescript
import { expect, it } from 'vitest';
import { OnboardingInputSchema } from '@jrc/contracts';
it('rejeita criacao de nova instancia sem providerAccountId', () => {
  expect(OnboardingInputSchema.safeParse({name:'Comercial',
    source:{kind:'NEW',instanceName:'Comercial'}, agentIds:[1],
    replaceExistingWebhook:false}).success).toBe(false);
});
it('nao aceita tenant arbitrario no input', () => {
  expect(OnboardingInputSchema.safeParse({organizationId:'other', name:'Comercial',
    source:{kind:'EXISTING',instanceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},
    agentIds:[1], replaceExistingWebhook:false}).success).toBe(false);
});
```

- [ ] **Passo 2 - executar RED e registrar a falha específica da funcionalidade ausente.** Falta de dependência/banco e bloqueio de ambiente, não evidência RED da regra.

```bash
npm test -- apps/api/tests/unit/chatwoot-onboarding.test.ts
```

- [ ] **Passo 3 - implementar as mudancas definidas a seguir.**


```typescript
const stages = ['INSTANCE','ACTIVATE_CHANNEL','LINK_INBOX','ASSIGN_AGENTS','VERIFY','DONE'] as const;
// Persistir a intencao e o hash antes de executar a primeira etapa.
// A chave para cada servico filho deriva do ID duravel da operacao e da etapa.
const childKey = `${operation.id}:${operation.stage}`;
```

Implementar os estagios da especificação reaproveitando servicos existentes. `POST onboarding` retorna 202 com operação, ou resultado idempotente, sem manter request longa. Conexão existente de outra organização retorna 404; inbox não API retorna erro de tipo; webhook existente diferente exige confirmação explícita do admin.

Cada etapa tem lease duravel e persiste IDs antes de avancar. Conflito de mesma chave com hash diferente retorna 409. Falha ambígua não repete POST remoto. Restaurar após restart e conciliar usando callback único e IDs. Criação de conta Chatwoot não faz parte desta saga: a conta precisa estar vinculada antes. Mantem provisionamento legado separado.

- [ ] **Passo 4 - executar novamente o comando, conferir GREEN e realizar os critérios adicionais.**

PostgreSQL real: requisicoes concorrentes com mesma chave resultam em uma operação; restart entre cada etapa preserva IDs; timeout depois de remote-create não duplica inbox; erro na associação de agente não recria número; cancelamento não exclui recursos anteriores. Executar `npm run test:integration -- apps/api/tests/integration/chatwoot-onboarding.test.ts`.

- [ ] **Passo 5 - revisar diff, conferir secrets e registrar commit local.** Fazer stage somente dos arquivos desta tarefa, sem `git add .`.

```bash
git diff --check
git diff --cached --check
git commit -m "feat(chatwoot): persist connection onboarding"
```

## Tarefa B6: Pair, saude composta e continuidade do número

**Arquivos e responsabilidades:**
- Criar `apps/api/src/modules/integrations/chatwoot-control-service.ts` e `chatwoot-health.ts`.
- Modificar rota de controle e estender eventos QR/worker apenas para registrar evidência e bloquear troca de identidade.
- Acrescentar colunas de evidência/identidade necessárias na migração nova da tarefa B5, antes de aplica-la pela primeira vez, ou em próxima migração se já aplicada.
- Criar `apps/api/tests/unit/chatwoot-health.test.ts` e `apps/api/tests/http/chatwoot-pair.test.ts`.

**Interfaces:**
Consome ConnectionResponseSchema existente e principal validado. Produz `.status(principal,integrationId)`, `.pair(principal,integrationId,key)`, `.disconnect(principal,integrationId,key)`.
Produz `deriveTransportStatus({integrationReady,connected,callbackVerified,recentInbound,recentOutbound,activeFailure})`.
Persistir somente evidências/datas e identidade cifrada/fingerprint apropriado; QR permanece no mecanismo temporário existente.

- [ ] **Passo 1 - adicionar o teste de contrato/regressão abaixo no arquivo de teste indicado.** Complementar com os cenários de aceite da tarefa. Os imports novos apontam para símbolos produzidos nesta tarefa.

```typescript
import { expect, it } from 'vitest';
import { deriveTransportStatus } from '../../src/modules/integrations/chatwoot-health.js';
it('QR/conexao sem transporte comprovado nao e operacional', () => {
  expect(deriveTransportStatus({integrationReady:true, connected:true,
    callbackVerified:false, recentInbound:false, recentOutbound:false,
    activeFailure:false})).toBe('UNVERIFIED');
});
it('falha ativa prevalece sobre evidencia anterior', () => {
  expect(deriveTransportStatus({integrationReady:true, connected:true,
    callbackVerified:true, recentInbound:true, recentOutbound:true,
    activeFailure:true})).toBe('DEGRADED');
});
```

- [ ] **Passo 2 - executar RED e registrar a falha específica da funcionalidade ausente.** Falta de dependência/banco e bloqueio de ambiente, não evidência RED da regra.

```bash
npm test -- apps/api/tests/unit/chatwoot-health.test.ts apps/api/tests/http/chatwoot-pair.test.ts
```

- [ ] **Passo 3 - implementar as mudancas definidas a seguir.**


```typescript
if (v.activeFailure) return 'DEGRADED';
return v.integrationReady && v.connected && v.callbackVerified &&
  v.recentInbound && v.recentOutbound ? 'OPERATIONAL' : 'UNVERIFIED';
```

Resolver instanceId pelo channel da integração e chamar o InstanceService existente. Todas as respostas de pair/status usam no-store; não serializar o resultado QR na operação de onboarding, audit ou exception.

Primeira vinculacao de identidade requer admin. Reconexao deve conferir identidade autentica do provider contra número anteriormente aprovado antes de retomar transporte. Divergencia entra em `IDENTITY_CONFIRMATION_REQUIRED` na saude/diagnóstico e bloqueia despacho; permitir ao admin confirmar a substituição em operação explícita auditada, nunca a agente. Não copiar número completo para logs.

`allowedActions` deve resultar da política atual, não do estado do botão. O GET não pode produzir sessão/QR. Disconnect e efeito destrutivo separado de pausar integração; a UI deve distinguir ambos.

- [ ] **Passo 4 - executar novamente o comando, conferir GREEN e realizar os critérios adicionais.**

Testar QR expirado, duas abas, duas requisicoes concorrentes, troca de conta, estado stale do provider, usuário removido e troca de número pelo agente. Provar que apenas fechar a tela não pausa worker/mensageria. Um status READY legado continua significando configuração, não homologação ponta a ponta.

- [ ] **Passo 5 - revisar diff, conferir secrets e registrar commit local.** Fazer stage somente dos arquivos desta tarefa, sem `git add .`.

```bash
git diff --check
git diff --cached --check
git commit -m "feat(chatwoot): expose authorized pairing and health"
```

## Tarefa B7: Regressao, flags e contrato de compatibilidade

**Arquivos e responsabilidades:**
- Criar `apps/api/src/modules/integrations/chatwoot-compatibility.ts`.
- Criar `apps/api/tests/unit/chatwoot-compatibility.test.ts` e `apps/api/tests/integration/chatwoot-control-storage.test.ts`.
- Ampliar `apps/api/tests/integration/qr-chatwoot-storage.test.ts`, fixtures HTTP e E2E do portal.
- Modificar `apps/api/src/config/env.ts`, OpenAPI, inventário/varreduras de rotas e docs operacionais.
- Criar `docs/operations/chatwoot-external.md` e preencher matriz de validação.

**Interfaces:**
Produz `evaluateChatwootCapabilities({adminAccount,apiAccess,apiInbox,webhookSecret,signedCallback}): {state:'READY'|'UNVERIFIED'|'UNSUPPORTED',reasons:string[]}`.
As flags novas desligadas bloqueiam superficies novas, mas não removem endpoints/caminhos de dados legados. Não alegar compatibilidade com toda versão Chatwoot a partir do teste em um fork.

- [ ] **Passo 1 - adicionar o teste de contrato/regressão abaixo no arquivo de teste indicado.** Complementar com os cenários de aceite da tarefa. Os imports novos apontam para símbolos produzidos nesta tarefa.

```typescript
import { expect, it } from 'vitest';
import { evaluateChatwootCapabilities } from '../../src/modules/integrations/chatwoot-compatibility.js';
it('rejeita transporte sem segredo compativel', () => {
  expect(evaluateChatwootCapabilities({adminAccount:true,apiAccess:true,
    apiInbox:true,webhookSecret:false,signedCallback:false}).state).toBe('UNSUPPORTED');
});
it('leitura sem callback nao comprova transporte', () => {
  expect(evaluateChatwootCapabilities({adminAccount:true,apiAccess:true,
    apiInbox:true,webhookSecret:true,signedCallback:false}).state).toBe('UNVERIFIED');
});
```

- [ ] **Passo 2 - executar RED e registrar a falha específica da funcionalidade ausente.** Falta de dependência/banco e bloqueio de ambiente, não evidência RED da regra.

```bash
npm test -- apps/api/tests/unit/chatwoot-compatibility.test.ts
```

- [ ] **Passo 3 - implementar as mudancas definidas a seguir.**


Criar também `apps/api/src/modules/integrations/chatwoot-compatibility.ts`, simbolo produzido nesta tarefa. Registrar capacidades observadas com data/versão da credencial; não preencher assinatura como suportada apenas porque o perfil respondeu 200.

```text
flags off + inbox legada -> transporte legado continua funcionando
external flag on + destino pendente -> bloquear antes de enviar token
secret ausente -> UNSUPPORTED
secret presente + callback nao observado -> UNVERIFIED
callback valido e contrato testado -> capacidade verificada
```

Completar a matriz de testes e a documentação de erros. Validar a fronteira em que Chatwoot tenta enviar enquanto broker esta fora; não declarar recuperacao sem observar retry/catch-up. Qualquer ausência de recuperacao deve ser bloqueio operacional explicitado no piloto, não ocultada por testes que comecam após o ACK.

- [ ] **Passo 4 - executar novamente o comando, conferir GREEN e realizar os critérios adicionais.**

Executar a suite completa disponível, build, typecheck, integration, E2E, compiled e verificações de contratos/submodulo/notices. Gerar OpenAPI, revisar e versionar o diff intencional; somente depois comparar nova geracao para garantir reprodutibilidade. Não exigir diff vazio contra a especificação antiga durante a alteração. Não reescrever auditorias históricas como nova auditoria. Gate B7 aprovado libera planos 02/03, não produção.

- [ ] **Passo 5 - revisar diff, conferir secrets e registrar commit local.** Fazer stage somente dos arquivos desta tarefa, sem `git add .`.

```bash
git diff --check
git diff --cached --check
git commit -m "test(chatwoot): validate external control compatibility"
```

## Gate do plano 01

```bash
npm run clean
npm run build
npm run typecheck
npm test
npm run test:web
npm run test:integration
npm run test:compiled
npm run test:e2e
npm run openapi:generate
npm run security:contracts
npm run security:notices
npm run security:submodule
git diff --check
```

Registrar comandos efetivamente executados, exit codes, testes omitidos por ambiente e limites. Repetir geracao OpenAPI depois do commit do novo contrato e exigir diff vazio. Não usar `npm audit fix --force` nem atualizar dependências em lote. A homologação remota e fase separada da evidência local.
