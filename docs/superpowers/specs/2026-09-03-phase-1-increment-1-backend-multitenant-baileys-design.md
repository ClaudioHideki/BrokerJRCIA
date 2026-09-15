# Fase 1 — Incremento 1: Backend multicliente e Baileys

**Status:** aprovado

**Data:** 03/09/2026

**Escopo:** primeiro incremento vertical do backend JRC

**Especificação superior:** [JRC WhatsApp Broker — Especificação de Arquitetura](./2026-09-03-jrc-whatsapp-broker-design.md)

## 1. Escopo e relação com a arquitetura geral

Este documento detalha somente o primeiro incremento do backend do JRC WhatsApp Broker. Ele não substitui nem amplia silenciosamente a especificação superior da arquitetura geral do produto.

O incremento entrega:

- fundação multicliente com organizações, usuários, memberships e isolamento obrigatório por `organization_id`;
- autenticação humana, seleção explícita da organização ativa, refresh tokens rotativos e API keys;
- RBAC mínimo e invariantes de propriedade;
- API pública JRC para criar, listar, consultar, conectar e desconectar instâncias;
- contrato canônico de providers;
- provider `BAILEYS` funcional por meio da Evolution API isolada;
- provider `META` somente como esqueleto tipado;
- auditoria básica, idempotência, provisionamento recuperável e reconciliação desacoplada;
- testes unitários, HTTP, contratos, integração PostgreSQL e smoke Evolution opt-in.

Terão especificações próprias antes da implementação:

- `apps/web` e experiência do usuário;
- `apps/worker`, filas e execução distribuída;
- webhooks completos e entrega externa de eventos;
- integração real com a Meta, Embedded Signup, WABA e Cloud API;
- mensageria completa, mídia, faturamento e WhatsApp Calling.

O submódulo `upstream/evolution-api` permanece imutável. Nenhuma API, DTO, erro ou identificador específico da Evolution integra o contrato público da JRC.

## 2. Base técnica e organização do monorepo

- monólito modular em TypeScript `strict`;
- Node.js 24 LTS fixado no Docker, CI e configuração local;
- Fastify para HTTP;
- PostgreSQL;
- Drizzle ORM com migrations SQL explícitas e versionadas;
- Zod como fonte dos contratos canônicos e schemas HTTP;
- Vitest;
- Evolution acessada somente pelo `EvolutionProviderAdapter` HTTP;
- sem microsserviços e sem Go neste incremento.

```text
apps/
  api/
    src/
      app.ts
      server.ts
      config/
      db/
      http/
      modules/
        organizations/
        users/
        memberships/
        auth/
        api-keys/
        instances/
        audit/
        reconciliation/
    tests/
      unit/
      http/
      integration/
      smoke/
    drizzle/
      migrations/
  web/
    README.md
  worker/
    README.md

packages/
  contracts/
    src/
      auth/
      instances/
      pagination/
      problems/
  providers/
    src/
      contracts/
      evolution/
      meta/
      registry.ts
  security/
    src/
      passwords/
      tokens/
      api-keys/
      challenges/
      redaction/
  ui/
    README.md

docs/
  api/
  architecture/
  baseline/
  superpowers/specs/
  superpowers/plans/

infra/
  app/
  baseline/

upstream/
  evolution-api/
```

`apps/web`, `apps/worker` e `packages/ui` reservam as fronteiras do monorepo, mas não recebem implementação funcional neste incremento.

## 3. Módulos e responsabilidades

| Módulo | Responsabilidade | Limite explícito |
| --- | --- | --- |
| Organizations | Identidade, estado e bootstrap inicial da organização | Não contém lógica do provider |
| Users | Identidade humana, e-mail e senha Argon2id | Não escolhe a organização ativa implicitamente |
| Memberships | Vínculo usuário–organização e papel | Não permite remover o último `OWNER` |
| Auth | Login, seleção da organização, JWT, refresh e logout | Não acessa instâncias antes de definir a organização |
| API keys | Emissão, HMAC, escopos, expiração e revogação | Nunca persiste ou lista o segredo bruto |
| Instances | Ciclo de vida público das instâncias JRC | Não conhece rotas ou DTOs Evolution |
| Audit | Auditoria tenant-aware | Nunca armazena credenciais ou desafios |
| Reconciliation | Recuperação de operações upstream incertas | Não depende de rotas HTTP nem de fila nesta fase |
| Provider contracts | Tipos canônicos compartilhados | Não pressupõe Baileys ou Evolution |
| Evolution adapter | Tradução entre contratos JRC e Evolution 2.3.7 | Credencial administrativa é segredo da plataforma |
| Meta adapter | Esqueleto tipado e erro canônico de indisponibilidade | Não realiza conexão real |

## 4. Roles PostgreSQL, transações e RLS

Serão usadas três roles:

- `jrc_migrator`: proprietária das estruturas e utilizada somente em migrations;
- `jrc_app`: role normal da aplicação, sem `SUPERUSER` e sem `BYPASSRLS`;
- `jrc_auth`: role separada, com grants mínimos para login, seleção de organização e refresh tokens; sem acesso a instâncias, operações, desafios ou auditoria tenant-aware.

Todas as tabelas multicliente têm `organization_id NOT NULL`. A política RLS usa contexto local à transação:

```sql
organization_id =
  NULLIF(current_setting('app.organization_id', true), '')::uuid
```

O helper `withOrganizationTransaction`:

1. obtém uma conexão do pool;
2. inicia uma transação curta;
3. aplica `set_config('app.organization_id', organizationId, true)`, equivalente transacional a `SET LOCAL`;
4. executa somente operações PostgreSQL;
5. confirma ou desfaz a transação;
6. devolve a conexão ao pool.

Chamadas HTTP à Evolution nunca ocorrem dentro de uma transação PostgreSQL. Testes verificam que commit, rollback e reutilização de conexões não vazam o contexto de uma organização para outra.

O pool de autenticação usa `jrc_auth` e consultas explicitamente limitadas. Depois da seleção de organização, toda operação multicliente usa `jrc_app` com RLS.

## 5. Modelo de dados

| Entidade | Campos e regras principais |
| --- | --- |
| `organizations` | `id`, `name`, `slug`, `status`, timestamps; `slug` único |
| `users` | `id`, `email`, `password_hash`, `status`, timestamps; e-mail normalizado único |
| `memberships` | `organization_id`, `user_id`, `role`, `status` (`ACTIVE` ou `DISABLED`), timestamps; única por organização e usuário |
| `login_sessions` | sessão curta entre login e seleção; somente hash, expiração e usuário |
| `refresh_tokens` | `user_id`, `organization_id`, `family_id`, hash, expiração, revogação e substituição |
| `api_keys` | `organization_id`, nome, prefixo, HMAC, escopos, expiração, revogação e último uso |
| `provider_accounts` | `organization_id`, provider, nome, referência externa e referência de credencial |
| `instances` | `organization_id`, provider account, nome, chave upstream, referência externa, estado e capacidades |
| `provider_operations` | operação durável, estado, tentativas, erro canônico e necessidade de reconciliação |
| `connection_challenges` | desafio cifrado, nonce, autenticação associada, expiração e consumo |
| `idempotency_records` | organização, rota, chave, hash da requisição, operação e resultado seguro |
| `security_audit_logs` | eventos pré-autenticação sem vínculo obrigatório com tenant |
| `audit_logs` | eventos vinculados a `organization_id`, ator e recurso |

Constraints obrigatórias:

- `UNIQUE (organization_id, route, idempotency_key)` em `idempotency_records`;
- `UNIQUE (upstream_instance_key)` em `instances`;
- chaves estrangeiras compostas incluem `organization_id` quando ligam entidades multicliente;
- um `provider_account` lógico `BAILEYS` por organização neste incremento;
- constraint trigger adiada impede que uma organização termine uma transação sem `OWNER`.

### 5.1 Provider account e credenciais

A credencial administrativa da Evolution pertence à plataforma JRC. Ela fica em secrets de infraestrutura e é injetada somente no `EvolutionProviderAdapter`.

Cada tenant recebe um `provider_account` lógico `BAILEYS`, usado para associar suas instâncias ao provider canônico. Esse registro não contém nem duplica a chave administrativa da Evolution.

Clientes:

- nunca fornecem a chave administrativa da Evolution;
- nunca recebem essa chave;
- nunca recebem identificadores, erros ou contratos internos da Evolution.

O modelo separa conta de provider e instância. No provider Meta futuro, a conta poderá representar uma WABA e a instância poderá referenciar um `phone_number_id`, sem alteração do contrato canônico.

## 6. Bootstrap seguro

Um comando administrativo one-shot cria atomicamente:

- a primeira organização;
- o primeiro usuário;
- a primeira membership `OWNER`.

Regras do bootstrap:

- só executa quando ainda não existe organização;
- adquire advisory lock para impedir execuções concorrentes;
- usa a role de bootstrap/migration, nunca a role normal da aplicação;
- recebe senha por prompt oculto ou entrada segura, não por argumento de linha de comando;
- gera o hash Argon2id antes de persistir;
- cria organização, usuário e membership na mesma transação;
- desfaz tudo se qualquer etapa falhar;
- não imprime senha, hash ou token;
- registra resultado sanitizado em `security_audit_logs`;
- recusa novas execuções depois do primeiro bootstrap.

Criação posterior de organizações e memberships ficará sujeita a RBAC e terá contrato próprio no plano de implementação.

## 7. Autenticação, seleção da organização e RBAC

### 7.1 Login em duas etapas

1. `POST /v1/auth/login` valida e-mail e senha.
2. O serviço consulta as memberships ativas usando `jrc_auth`.
3. Retorna as organizações permitidas e um token opaco de seleção, curto e de uso limitado.
4. O cliente chama `POST /v1/auth/select-organization` com a organização escolhida.
5. O serviço revalida a membership para evitar seleção com dados obsoletos.
6. Emite JWT curto com `organization_id` ativo e refresh token rotativo.
7. Apenas o hash do token opaco e do refresh token é persistido.

O token de seleção não autoriza endpoints de negócio. Ele expira rapidamente, não contém senha e não substitui o JWT de acesso.

```text
POST /v1/auth/login
POST /v1/auth/select-organization
POST /v1/auth/refresh
POST /v1/auth/logout
```

Todas as respostas de autenticação usam `Cache-Control: no-store`.

### 7.2 Refresh tokens

- rotação em cada uso;
- revogação individual e por família;
- detecção de reutilização de token revogado;
- invalidação da família quando houver reutilização;
- armazenamento somente do hash;
- vínculo explícito com usuário e organização ativa.

### 7.3 API keys

- segredo de alta entropia exibido uma única vez;
- prefixo pesquisável;
- HMAC-SHA-256 com segredo diferente do segredo JWT;
- comparação constante;
- escopos mínimos, expiração e revogação;
- segredo e HMAC nunca aparecem em listagens ou logs.

### 7.4 Matriz RBAC

| Operação | OWNER | ADMIN | OPERATOR | VIEWER |
| --- | :---: | :---: | :---: | :---: |
| Ler instâncias e status | Sim | Sim | Sim | Sim |
| Criar, conectar e desconectar | Sim | Sim | Sim | Não |
| Gerenciar API keys | Sim | Sim | Não | Não |
| Gerenciar memberships não-OWNER | Sim | Sim | Não | Não |
| Promover, remover ou rebaixar OWNER | Sim | Não | Não | Não |

Somente `OWNER` altera outra membership `OWNER`. `ADMIN` nunca assume propriedade implicitamente. Locks e constraint trigger impedem remoções concorrentes do último `OWNER`.

### 7.5 Proteção contra abuso e enumeração

Os endpoints de autenticação aplicam controles combinados, sem depender de um único identificador:

- rate limit por IP e por identidade normalizada, com limites e janelas configuráveis;
- normalização de e-mail antes da derivação da chave de rate limit;
- chave de rate limit de identidade derivada por HMAC-SHA-256 do e-mail normalizado;
- segredo desse HMAC exclusivo para rate limit, separado dos segredos JWT, API key e criptografia de desafios;
- verificação Argon2id fictícia, com parâmetros equivalentes aos hashes reais, quando o usuário não existir;
- resposta externa genérica e temporalmente uniforme para e-mail, senha, organização ou membership inválida;
- atraso progressivo para tentativas repetidas, com limite máximo para evitar retenção indefinida de recursos;
- nenhuma confirmação de existência de usuário, organização ou vínculo antes de autenticação válida;
- contadores com TTL identificados somente pelo resultado do HMAC, sem senha, token ou e-mail em texto aberto;
- auditoria sanitizada de bloqueios e liberações em `security_audit_logs`;
- `X-Request-Id` para correlação operacional sem incluir credenciais nos eventos.

O atraso e o rate limit serão testáveis por relógio injetável. A implementação não manterá conexão PostgreSQL nem worker HTTP bloqueado por espera ativa; respostas retardadas usarão mecanismo assíncrono e limites explícitos.

## 8. Provisionamento e reconciliação

O `upstream_instance_key` é determinístico, gerado pela JRC a partir do UUID interno e não contém nome, telefone ou informação do cliente.

Fluxo:

1. autenticar e autorizar;
2. abrir transação curta com RLS;
3. validar idempotência;
4. criar instância local como `PROVISIONING`;
5. registrar a operação de provisionamento;
6. confirmar a transação;
7. chamar a Evolution com timeout explícito;
8. abrir nova transação curta;
9. atualizar para `CREATED` ou `PROVISIONING_FAILED`;
10. em resultado incerto, marcar `reconciliation_required`;
11. confirmar a transação.

O caso de uso de reconciliação não pertence à rota e não conhece Fastify. Ele consulta a Evolution pela chave determinística:

- se a instância existir, vincula a referência e conclui como `CREATED`;
- se não existir, repete o provisionamento com a mesma chave;
- locks e unicidade impedem duplicação.

Neste incremento não haverá fila. Um executor interno desacoplado poderá chamar o caso de uso periodicamente. Posteriormente, a mesma porta de aplicação será acionada por `apps/worker` sem modificar as rotas HTTP ou a regra de domínio.

## 9. Idempotência e desafios

`idempotency_records` armazena somente:

- organização, rota e chave;
- hash da requisição;
- referência da operação;
- status e metadados seguros;
- expiração.

QR Code, pairing code, telefone, token e segredo não integram a resposta serializada aberta.

Para `connect`:

- mesma chave e mesmo payload reutilizam a operação;
- mesma chave e payload diferente retornam `409 IDEMPOTENCY_CONFLICT`;
- operação em andamento retorna `202`;
- instância conectada retorna ação `NONE`;
- replays nunca criam outra instância upstream.

Quando um desafio precisar ser reproduzido, ele será cifrado com AES-256-GCM, chave própria, nonce aleatório e TTL curto. O dado será associado a organização, instância e operação e removido após consumo ou expiração. Desafios nunca aparecem em logs ou auditoria.

## 10. Contrato canônico dos providers

```ts
interface WhatsAppProvider {
  readonly kind: 'BAILEYS' | 'META';

  provisionInstance(
    context: ProviderContext,
    input: ProvisionInstanceInput,
  ): Promise<ProvisionedInstance>;

  beginConnection(
    context: ProviderContext,
    input: BeginConnectionInput,
  ): Promise<ConnectionAction>;

  getStatus(
    context: ProviderContext,
    reference: ProviderInstanceReference,
  ): Promise<ProviderStatus>;

  disconnect(
    context: ProviderContext,
    reference: ProviderInstanceReference,
  ): Promise<void>;
}

interface WhatsAppProviderAdmin {
  lookupInstance(
    context: ProviderContext,
    reference: ProviderInstanceReference,
  ): Promise<ProviderInstanceLookup>;

  reconcileProvisioning(
    context: ProviderContext,
    input: ReconcileProvisioningInput,
  ): Promise<ProvisioningReconciliation>;

  deprovisionInstance(
    context: ProviderContext,
    reference: ProviderInstanceReference,
  ): Promise<void>;
}
```

`WhatsAppProvider` é o contrato comum consumido pelos casos de uso normais. `WhatsAppProviderAdmin` é um contrato interno separado, disponível apenas para compensação, reconciliação e ferramentas operacionais autorizadas. O `EvolutionProviderAdapter` implementa ambos; rotas públicas recebem somente o contrato comum.

`ProviderContext` inclui `request_id`, deadline e `AbortSignal`. O adapter define timeouts distintos para provisionamento, início de conexão, status, desconexão, deprovisionamento e reconciliação.

`lookupInstance`, `reconcileProvisioning` e `deprovisionInstance` pertencem somente ao contrato administrativo interno. Nenhuma delas possui endpoint público neste incremento. `lookupInstance` é estritamente somente leitura: informa existência, referência e estado canônico sem criar, conectar, reconciliar ou alterar a instância upstream. `deprovisionInstance` fica restrita a compensação controlada, reconciliação e cleanup de testes. `disconnect` encerra a sessão, mas não remove a instância da Evolution e, portanto, não é considerado cleanup.

`ConnectionAction` é uma união discriminada não específica de Baileys:

```ts
type ConnectionAction =
  | { type: 'QR_CODE'; encoding: 'DATA_URL' | 'BASE64'; value: string; expiresAt: string }
  | { type: 'PAIRING_CODE'; code: string; expiresAt: string }
  | { type: 'EMBEDDED_SIGNUP'; flowId: string; expiresAt: string }
  | { type: 'REDIRECT'; url: string; expiresAt: string }
  | {
      type: 'NONE';
      reason: 'ALREADY_CONNECTED' | 'CONNECTION_PENDING' | 'NO_USER_ACTION_REQUIRED';
    };
```

O adapter Meta retorna erro canônico `PROVIDER_NOT_AVAILABLE` neste incremento.

## 11. API HTTP JRC

Regras gerais:

- prefixo `/v1`;
- schemas Zod compartilhados em `packages/contracts`;
- OpenAPI gerado dos mesmos schemas e validado em testes;
- `X-Request-Id` validado ou gerado, retornado e propagado ao provider;
- erros `application/problem+json` sem conteúdo upstream;
- acesso cruzado retorna `404` sem invocar o provider;
- paginação por cursor, limite padrão 20 e máximo 100;
- ordenação estável por `created_at` e `id`;
- JWT em `Authorization: Bearer`;
- API key em `X-JRC-API-Key`;
- `Idempotency-Key` obrigatório nas mutações de instância.

### 11.1 API keys

```text
POST   /v1/api-keys
GET    /v1/api-keys?limit=20&cursor=...
DELETE /v1/api-keys/:id
```

Criação e listagem usam `Cache-Control: no-store`.

### 11.2 Instâncias

```text
POST /v1/instances
GET  /v1/instances?limit=20&cursor=...
GET  /v1/instances/:id
POST /v1/instances/:id/connect
GET  /v1/instances/:id/status
POST /v1/instances/:id/disconnect
```

Respostas de desafio usam:

```http
Cache-Control: no-store
Pragma: no-cache
```

Estados públicos:

```text
PROVISIONING
CREATED
PROVISIONING_FAILED
CONNECTING
AWAITING_ACTION
CONNECTED
DISCONNECTING
DISCONNECTED
ERROR
```

## 12. Auditoria e redaction

`security_audit_logs` registra eventos anteriores à seleção de tenant, como:

- login aceito ou negado;
- bloqueio e liberação por rate limit de IP ou identidade normalizada;
- aplicação de atraso progressivo, sem registrar a identidade em texto aberto;
- bootstrap inicial;
- falha ou reutilização de token de seleção;
- tentativa de refresh inválida quando não for possível vincular com segurança a uma organização.

`audit_logs` sempre possui `organization_id` e registra:

- seleção de organização;
- emissão e revogação de API key;
- alteração de membership;
- criação, conexão e desconexão de instância;
- reconciliação;
- acesso cruzado negado quando o tenant ativo é conhecido.

Nenhum log ou auditoria armazena senha, JWT, refresh token, API key, QR Code, pairing code, telefone, credencial de provider ou corpo bruto da Evolution. Headers e campos sensíveis são redigidos no logger.

## 13. Exposição da Evolution

Em desenvolvimento e smoke local, a Evolution pode ser vinculada somente a `127.0.0.1`.

Em produção:

- a Evolution não publica porta para a rede externa;
- somente componentes internos autorizados alcançam sua rede privada;
- clientes acessam exclusivamente a API JRC;
- firewall, ingress e Compose/Kubernetes devem impedir exposição acidental;
- a credencial administrativa fica em secrets da plataforma e nunca em configuração do tenant.

## 14. Testes e CI

### 14.1 `npm test`

Sem Docker:

- domínio e RBAC;
- login, seleção de organização, refresh e logout com doubles;
- API keys;
- contratos dos providers;
- endpoints com adapter falso;
- paginação, idempotência e erros;
- OpenAPI;
- garantia de ausência de tipos Evolution na API pública.

### 14.2 `npm run test:integration`

Contra PostgreSQL real:

- migrations do zero;
- roles e grants;
- constraints compostas e unicidades;
- RLS e ausência de contexto;
- commit, rollback e reutilização do pool;
- ausência de vazamento entre organizações;
- invariantes de `OWNER` sob concorrência;
- operações duráveis, idempotência e criptografia de desafios.

### 14.3 `npm run test:smoke:evolution`

Separado e opt-in por `EVOLUTION_SMOKE_ENABLED=true`:

1. gera uma chave upstream determinística exclusiva do teste;
2. provisiona a instância;
3. inicia conexão e valida a normalização do desafio;
4. consulta o status;
5. desconecta;
6. executa cleanup obrigatório em `finally` por `deprovisionInstance`, removendo a instância upstream mesmo após falha intermediária;
7. confirma o cleanup ou falha explicitamente;
8. nunca usa dados ou credenciais de clientes.

O teste não considera `disconnect` suficiente: após o `finally`, a consulta administrativa à Evolution deve confirmar que a instância deixou de existir.

### 14.4 CI

- Node.js 24 LTS fixado;
- PostgreSQL real como serviço;
- `npm ci`;
- typecheck `strict`;
- migrations do zero;
- `npm test`;
- `npm run test:integration`;
- geração e validação do OpenAPI;
- `npm audit --audit-level=high`;
- `git diff --check`.

O smoke Evolution não bloqueia o CI comum; poderá executar em ambiente dedicado autorizado.

## 15. Critérios de aceite

1. `npm test` passa sem Docker.
2. `npm run test:integration` passa contra PostgreSQL real.
3. RLS bloqueia acesso cruzado e não há vazamento no pool.
4. `jrc_app` não possui `BYPASSRLS`.
5. Nenhuma transação permanece aberta durante HTTP upstream.
6. O bootstrap cria exatamente uma organização, um usuário e uma membership `OWNER` de forma atômica.
7. Login lista apenas organizações permitidas e JWT só é emitido após seleção válida.
8. Refresh tokens e API keys existem apenas como hash ou HMAC.
9. A organização nunca fica sem `OWNER` e `ADMIN` não altera propriedade.
10. `UNIQUE (organization_id, route, idempotency_key)` impede corrida de idempotência.
11. `upstream_instance_key` é único e determinístico.
12. Timeout de provisionamento é reconciliável sem duplicar instância.
13. Replays de conexão não persistem desafios em texto aberto.
14. O contrato `ConnectionAction` suporta `QR_CODE`, `PAIRING_CODE`, `EMBEDDED_SIGNUP`, `REDIRECT` e `NONE`.
15. Endpoints funcionam com adapter falso sem Docker.
16. Smoke Evolution é opt-in e sempre executa cleanup.
17. OpenAPI é gerado e validado.
18. Coleções usam paginação por cursor.
19. Respostas incluem `X-Request-Id`.
20. Autenticação, API keys e desafios usam `Cache-Control: no-store`.
21. Timeouts do adapter são explícitos e testados.
22. Clientes nunca fornecem nem recebem a credencial administrativa da Evolution.
23. A Evolution não é exposta publicamente em produção.
24. Nenhum contrato público revela detalhes da Evolution.
25. O submódulo permanece no commit fixado e sem alterações.
26. Licenças, avisos e atribuições permanecem intactos.
27. Nenhuma fila, frontend, worker funcional ou conexão Meta real é implementada neste incremento.
28. Alterações são apresentadas antes de commit ou push.
29. Login e seleção de organização resistem a enumeração, abuso por IP e abuso por identidade normalizada.
30. `deprovisionInstance` existe somente no contrato administrativo interno e remove efetivamente a instância no cleanup do smoke test.

## 16. Fora do escopo

- painel web;
- implementação funcional de `apps/worker`;
- filas e processamento distribuído;
- webhooks externos completos;
- Meta real, Embedded Signup e Cloud API;
- mensageria e mídia completas;
- faturamento;
- WhatsApp Calling;
- otimizações em Go sem benchmark que demonstre necessidade.
