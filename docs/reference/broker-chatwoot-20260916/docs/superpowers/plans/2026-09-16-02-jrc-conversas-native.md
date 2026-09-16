# JRC Conversas: interface nativa e backend intermediário - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir configuração administrativa e reconexão delegada dentro do JRC Conversas, usando a API de controle do broker.

**Architecture:** Vue chama somente o backend Rails da própria origem. Rails valida usuário/conta/inbox e chama o broker com chave limitada; o transporte permanece na caixa API.

**Tech Stack:** Ruby/Rails e versão de .ruby-version; Vue 3 Composition API, Tailwind, pnpm/Vitest, RSpec; dependências do lockfile.

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

## Dependência, checkout e arquivos

Depende do gate B7 do plano 01 e do contrato de controle versionado. Raiz dos caminhos abaixo: checkout de `ClaudioHideki/jrc-conversas-nico-v12-2-7-comercial-integrado`. Não executar migrações Rails no banco do broker.

Ler `AGENTS.md`, `README.md`, `.ruby-version`, `Gemfile.lock`, `package.json`, lockfile pnpm, routes e mecanismos de configuração/criptografia existentes. Branch de integração proposta: `codex/jrc-broker-native`; usar worktree isolado por tarefa conforme o AGENTS. Ler o overlay `enterprise/` para policies/controllers alterados, sem contornar verificações de licenca/feature.

```bash
git status --short
git rev-parse HEAD
cat .ruby-version
ruby --version
bundle --version
pnpm --version
rg -n 'InboxPolicy|DashboardAppsController|WebhookListener' app enterprise
```

Arquivos novos concentrados em `app/services/jrc_broker/`, controller dedicado, modelos de vinculo/grant e componentes Vue específicos. Não refatorar NICO, Comercial, CRM, chamadas ou outros canais.

Criar migração Rails `CreateJrcBrokerIntegrationTables` com timestamp gerado pelo ambiente, preservando histórico existente. O nome exato do arquivo com timestamp deve ser registrado no diff; não assumir a versão Rails por memoria.

## Tarefa J1: Configuração cifrada por conta e vinculos locais

**Arquivos e responsabilidades:**
- Criar `app/models/jrc_broker_integration.rb`, `jrc_broker_inbox_binding.rb`, `jrc_broker_inbox_grant.rb` e migração Rails correspondente.
- Criar `app/services/jrc_broker/credential_store.rb` e `app/services/jrc_broker/configuration.rb`.
- Criar `spec/models/jrc_broker_integration_spec.rb` e `spec/services/jrc_broker/credential_store_spec.rb`.
- Modificar `.env.example` e filtro de parâmetros/logs seguindo o mecanismo existente.

**Interfaces:**
Produz `JrcBroker::CredentialStore.new(key:)`, `encrypt(account_id:, token:)` e `decrypt(account_id:, ciphertext:)`.
Produz configuração por `account_id`, origem do broker administrativamente permitida, UUID da organização confirmado pelo broker e chave cifrada. Nenhum serializer retorna chave/ciphertext; somente `configured` e `has_credential`.
Produz modelos de binding e grant com escopo da conta e índices de unicidade.

- [ ] **Passo 1 - adicionar o teste de contrato/regressão abaixo no arquivo de teste indicado.** Complementar com os cenários de aceite da tarefa. Os imports novos apontam para símbolos produzidos nesta tarefa.

```ruby
require 'rails_helper'
RSpec.describe JrcBroker::CredentialStore do
  let(:store) { described_class.new(key: SecureRandom.random_bytes(32)) }
  it 'vincula a cifra a conta e nao persiste o token em claro' do
    ciphertext = store.encrypt(account_id: 1, token: 'synthetic-control-token')
    expect(ciphertext).not_to include('synthetic-control-token')
    expect(store.decrypt(account_id: 1, ciphertext: ciphertext)).to eq('synthetic-control-token')
    expect { store.decrypt(account_id: 2, ciphertext: ciphertext) }.to raise_error(JrcBroker::CredentialStore::InvalidCredential)
  end
end
```

- [ ] **Passo 2 - executar RED e registrar a falha específica da funcionalidade ausente.** Falta de dependência/banco e bloqueio de ambiente, não evidência RED da regra.

```bash
bundle exec rspec spec/services/jrc_broker/credential_store_spec.rb spec/models/jrc_broker_integration_spec.rb
```

- [ ] **Passo 3 - implementar as mudancas definidas a seguir.**


```ruby
@encryptor = ActiveSupport::MessageEncryptor.new(key, cipher: 'aes-256-gcm')
@encryptor.encrypt_and_sign(token, purpose: "jrc-broker:account:#{account_id}")
# decrypt_and_verify usa o mesmo purpose; retorno nil/falha vira InvalidCredential.
```

Usar chave dedicada `JRC_BROKER_CREDENTIAL_KEY` de 32 bytes decodificados de base64; validar formato no servidor, falhar se ausente quando feature habilitada. Não criar fallback de chave fixa nem registrar valor. Documentar rotação com leitura antiga/reescrita controlada e backup privado.

Validar no banco/modelo que inbox e usuário pertencem a conta correspondente. Configuração só e salva após `/control/context` confirmar que a chave e restrita a esta conta/origem Chatwoot. Origem do broker e permitida pelo administrador da instalação, não URL livre de qualquer agente. Nenhum token administrativo Chatwoot precisa ir ao Rails: ele já fica no broker.

A migração adiciona tabelas e índices, sem transformar canais existentes nem copiar sessões. Não usar additional_attributes como cofre ou como prova de autorização.

- [ ] **Passo 4 - executar novamente o comando, conferir GREEN e realizar os critérios adicionais.**

Testar cifra com chave errada, conta errada, valor adulterado e serializer sem segredo. Testar binding com inbox de outra conta e grant para usuário não membro. Feature desligada não exige nova chave e não afeta boot legado. Backup/restauracao deve incluir a chave no cofre, nunca no Git.

- [ ] **Passo 5 - revisar diff, conferir secrets e registrar commit local.** Fazer stage somente dos arquivos desta tarefa, sem `git add .`.

```bash
git diff --check
git diff --cached --check
git commit -m "feat(jrc-broker): persist account integration safely"
```

## Tarefa J2: Policies, endpoints Rails e cliente server-side

**Arquivos e responsabilidades:**
- Criar `app/controllers/api/v1/accounts/jrc_broker_controller.rb` e `app/services/jrc_broker/client.rb`.
- Criar `app/policies/jrc_broker_policy.rb`, `app/services/jrc_broker/access.rb` e `app/services/jrc_broker/context.rb`.
- Modificar `config/routes.rb` e registrar feature flag pelo mecanismo existente.
- Criar `spec/services/jrc_broker/access_spec.rb`, `spec/requests/api/v1/accounts/jrc_broker_spec.rb` e `spec/services/jrc_broker/client_spec.rb`.

**Interfaces:**
Produz `JrcBroker::Access.allowed?(administrator:, assigned:, delegated:, action:)` e policy que obtem esses valores do Current.account/user e das tabelas, nunca do corpo HTTP.
Cliente produz `context`, `start_onboarding`, `onboarding`, `status`, `pair`, `disconnect`, `assign_agents` conforme o contrato de controle. Mapeamento inbox -> integrationId vem do binding local conferido com broker.

- [ ] **Passo 1 - adicionar o teste de contrato/regressão abaixo no arquivo de teste indicado.** Complementar com os cenários de aceite da tarefa. Os imports novos apontam para símbolos produzidos nesta tarefa.

```ruby
require 'rails_helper'
RSpec.describe JrcBroker::Access do
  it 'nao transforma agente delegado em administrador' do
    expect(described_class.allowed?(administrator: false, assigned: true, delegated: true, action: :pair)).to be(true)
    expect(described_class.allowed?(administrator: false, assigned: true, delegated: true, action: :disconnect)).to be(false)
    expect(described_class.allowed?(administrator: false, assigned: false, delegated: true, action: :pair)).to be(false)
  end
  it 'bloqueia pareamento sem delegacao' do
    expect(described_class.allowed?(administrator: false, assigned: true, delegated: false, action: :pair)).to be(false)
  end
end
```

- [ ] **Passo 2 - executar RED e registrar a falha específica da funcionalidade ausente.** Falta de dependência/banco e bloqueio de ambiente, não evidência RED da regra.

```bash
bundle exec rspec spec/services/jrc_broker/access_spec.rb spec/requests/api/v1/accounts/jrc_broker_spec.rb spec/services/jrc_broker/client_spec.rb
```

- [ ] **Passo 3 - implementar as mudancas definidas a seguir.**


```ruby
return true if administrator
return assigned if action == :status
return assigned && delegated if action == :pair
false
```

A conta deve estar autorizada antes dessa regra; o bool administrator e sempre o papel nessa conta. Controller herda `Api::V1::Accounts::BaseController`; scoped find em Current.account impede IDOR. Manter proteção CSRF/sessão e checagens de API existentes. Nenhuma rota de controle pode ficar em webhook público.

Implementar rotas da especificação. Propagar Idempotency-Key para mutacoes, timeouts curtos e código de problema sanitizado. Não segurar transação Rails enquanto aguarda broker. Onboarding e asincrono: responder operationId e consultar depois; salvar binding somente ao validar resultado completo e inbox local pertencente a conta.

Adicionar grant por inbox exclusivo de admin e revogação imediata. Dados de auditoria do usuário externo são derivados do Current.user no servidor. Não refletir organizationId/accountId arbitrários do navegador. Respostas pair: Cache-Control no-store e Pragma no-cache; logs não incluem body/QR/token.

- [ ] **Passo 4 - executar novamente o comando, conferir GREEN e realizar os critérios adicionais.**

Request specs: admin A, agente A delegado, agente A não delegado, usuário B, tentativa de trocar account_id/inbox_id/integrationId, sessão sem CSRF, chave revogada e feature desligada. Validar que request body nunca determina organizationId ou ator. Cliente deve preservar chave só no header server-side e recusar redirects de origem.

- [ ] **Passo 5 - revisar diff, conferir secrets e registrar commit local.** Fazer stage somente dos arquivos desta tarefa, sem `git add .`.

```bash
git diff --check
git diff --cached --check
git commit -m "feat(jrc-broker): add authorized Rails control endpoints"
```

## Tarefa J3: Criação nativa da caixa e painel de QR

**Arquivos e responsabilidades:**
- Criar `app/javascript/dashboard/routes/dashboard/settings/inbox/channels/JrcBroker.vue`.
- Criar `app/javascript/dashboard/components-next/jrc-broker/ConnectionPanel.vue`, `pairingState.js` e `__tests__/pairingState.spec.js`.
- Criar `app/javascript/dashboard/api/jrcBroker.js` e `app/javascript/dashboard/i18n/locale/en/jrcBroker.json`; registrar carregamento conforme loader existente.
- Modificar `ChannelFactory.vue`, `ChannelList.vue`, `InboxChannels.vue` e `Settings.vue` no diretório `routes/dashboard/settings/inbox/` somente nos pontos necessários.
- Criar testes de componente junto de `components-next/jrc-broker/__tests__/`.

**Interfaces:**
Produz `isPairingActionUsable(action, nowMs)`; consome formato atual `ConnectionActionSchema` e expiresAt.
API Vue usa somente URLs Rails same-origin. ConnectionPanel recebe accountId/inboxId ou operationId, mas permissões e IDs de destino confiáveis vem do backend. Rotulo JRC não muda Channel::Api.

- [ ] **Passo 1 - adicionar o teste de contrato/regressão abaixo no arquivo de teste indicado.** Complementar com os cenários de aceite da tarefa. Os imports novos apontam para símbolos produzidos nesta tarefa.

```javascript
import { describe, expect, it } from 'vitest';
import { isPairingActionUsable } from '../pairingState';
describe('QR temporario', () => {
  it('nao exibe QR expirado', () => {
    const action = { type: 'QR_CODE', encoding: 'DATA_URL', value: 'synthetic',
      expiresAt: '2026-09-16T12:00:00Z' };
    expect(isPairingActionUsable(action, Date.parse('2026-09-16T12:00:01Z'))).toBe(false);
  });
  it('nao trata estado sem acao como QR', () => {
    expect(isPairingActionUsable({type:'NONE',reason:'ALREADY_CONNECTED'}, 0)).toBe(false);
  });
});
```

- [ ] **Passo 2 - executar RED e registrar a falha específica da funcionalidade ausente.** Falta de dependência/banco e bloqueio de ambiente, não evidência RED da regra.

```bash
pnpm exec vitest run app/javascript/dashboard/components-next/jrc-broker/__tests__/pairingState.spec.js
```

- [ ] **Passo 3 - implementar as mudancas definidas a seguir.**


```javascript
export const isPairingActionUsable = (action, nowMs) =>
  ['QR_CODE', 'PAIRING_CODE'].includes(action?.type) &&
  Number.isFinite(Date.parse(action.expiresAt)) &&
  Date.parse(action.expiresAt) > nowMs;
```

Adicionar card JRC Broker no seletor e componente próprio na factory. Sequencia: selecao de instância existente/nova -> nome da inbox/agentes -> onboarding persistente -> resultado -> pair -> confirmação. Com conta ainda não configurada, direcionar admin para configuração específica sem pedir chave ao agente.

Implementar tela com estados: criando, aguardando QR, QR expirado, conectando, conectado, transporte não verificado, erro recuperavel e conciliacao necessária. Não exibir READY como se fosse número conectado. Configuração e transporte mostram indicadores separados.

QR renderizado a partir de DATA_URL/BASE64 PNG validado, nunca por v-html ou URL arbitrária. Limpar refs em unmount, logout, troca de conta/inbox e CONNECTED. Polling status a cada 3s somente com tela visível; nova chave idempotente apenas para nova intencao de pair. Não persistir QR em Vuex persistido/localStorage/sessionStorage nem incluir em telemetria.

Respeitar Tailwind e i18n do AGENTS. Os nomes de arquivos Vue acima são novos e não substituem todos os Settings/ChannelFactory. Checar responsividade e teclado.

- [ ] **Passo 4 - executar novamente o comando, conferir GREEN e realizar os critérios adicionais.**

Testes com fake timers: expiração, troca de conta, desmontagem cancela polling, callback tardio não preenche QR da conta anterior, duplo clique não cria duas caixas. Testes com navegacao real: página sem credencial não vaza token em bundle/config/rede de browser. Build deve incluir novas strings-fonte pelo mecanismo de i18n correto.

- [ ] **Passo 5 - revisar diff, conferir secrets e registrar commit local.** Fazer stage somente dos arquivos desta tarefa, sem `git add .`.

```bash
git diff --check
git diff --cached --check
git commit -m "feat(jrc-broker): add native inbox pairing flow"
```

## Tarefa J4: Acesso do agente no atendimento sem abrir configurações

**Arquivos e responsabilidades:**
- Criar `app/javascript/dashboard/components-next/jrc-broker/ConnectionButton.vue` e teste `__tests__/ConnectionButton.spec.js`.
- Modificar `app/javascript/dashboard/components/widgets/conversation/ConversationHeader.vue`.
- Ampliar policy/request specs e serializers sanitizados de status.
- Adicionar tela administrativa de concessões ao painel da inbox existente.

**Interfaces:**
Consome `allowedActions` do status; ConnectionButton abre o mesmo ConnectionPanel, sem acesso a formulário administrativo. Produz funcao `visibleConnectionActions(allowedActions)` em `pairingState.js` para filtrar somente `status|pair|disconnect|manage` conhecidos. Visibilidade não substitui validação backend.

- [ ] **Passo 1 - adicionar o teste de contrato/regressão abaixo no arquivo de teste indicado.** Complementar com os cenários de aceite da tarefa. Os imports novos apontam para símbolos produzidos nesta tarefa.

```javascript
import { expect, it } from 'vitest';
import { visibleConnectionActions } from '../pairingState';
it('nao inventa permissao administrativa para agente', () => {
  expect(visibleConnectionActions(['status', 'pair'])).toEqual(['status', 'pair']);
  expect(visibleConnectionActions(['status', 'unknown'])).toEqual(['status']);
});
```

- [ ] **Passo 2 - executar RED e registrar a falha específica da funcionalidade ausente.** Falta de dependência/banco e bloqueio de ambiente, não evidência RED da regra.

```bash
pnpm exec vitest run app/javascript/dashboard/components-next/jrc-broker/__tests__
```

- [ ] **Passo 3 - implementar as mudancas definidas a seguir.**


```javascript
export const visibleConnectionActions = actions =>
  actions.filter(action => ['status','pair','disconnect','manage'].includes(action));
```

Cabeçalho identifica inbox atual e mostra estado somente para binding JRC confirmado. Não inferir integração apenas por nome, icone ou additional_attributes. Agente delegado pode reconectar uma identidade previamente aprovada; não criar primeira vinculacao, editar token, alterar número, associar usuários nem desconectar.

Grant removido durante modal aberto: próxima chamada retorna 403, remove QR e encerra polling de pair. Grant não sobrevive a remoção do agente da inbox. Admin possui confirmação distinta para logout e substituição de identidade; mensagem explica impacto no canal empresarial.

- [ ] **Passo 4 - executar novamente o comando, conferir GREEN e realizar os critérios adicionais.**

Testar um mesmo agente em duas inboxes com delegacao em apenas uma. Testar troca de conversa/inbox com request em voo. Testar login em outra conta no mesmo navegador. Confirmar que demais ações/canais do ConversationHeader permanecem inalterados.

- [ ] **Passo 5 - revisar diff, conferir secrets e registrar commit local.** Fazer stage somente dos arquivos desta tarefa, sem `git add .`.

```bash
git diff --check
git diff --cached --check
git commit -m "feat(jrc-broker): expose delegated reconnection to agents"
```

## Tarefa J5: Contrato ponta a ponta e liberação por feature flag

**Arquivos e responsabilidades:**
- Criar `spec/requests/api/v1/accounts/jrc_broker_contract_spec.rb`.
- Adicionar cenários de navegador a suite existente do JRC; não introduzir um segundo framework de E2E sem necessidade.
- Atualizar docs de operação, release notes e plano de rollback da feature.
- Confirmar integridade dos overlays enterprise, rotas existentes e pipelines de i18n.

**Interfaces:**
Produz evidência do caminho Vue -> Rails -> broker -> ChatwootClient -> Rails/inbox e retorno ao usuário. Consome os contratos do plano 01, sem mocks que dispensem autenticação/assinatura no teste de integração final.

- [ ] **Passo 1 - adicionar o teste de contrato/regressão abaixo no arquivo de teste indicado.** Complementar com os cenários de aceite da tarefa. Os imports novos apontam para símbolos produzidos nesta tarefa.

```ruby
require 'rails_helper'
RSpec.describe 'JRC Broker feature rollout' do
  it 'nao amplia os poderes da policy generica de inbox para reconectar' do
    expect(InboxPolicy.instance_methods(false)).to include(:create?, :update?)
    expect(JrcBrokerPolicy.instance_methods(false)).to include(:pair?, :disconnect?)
  end
end
```

- [ ] **Passo 2 - executar RED e registrar a falha específica da funcionalidade ausente.** Falta de dependência/banco e bloqueio de ambiente, não evidência RED da regra.

```bash
bundle exec rspec spec/requests/api/v1/accounts/jrc_broker_contract_spec.rb spec/requests/api/v1/accounts/jrc_broker_spec.rb
```

- [ ] **Passo 3 - implementar as mudancas definidas a seguir.**


O teste pequeno acima caracteriza separacao de policies; não e prova suficiente de E2E. Acrescentar teste real de contrato entre processos, com conta e número sintéticos no ambiente isolado, e roteiro de piloto autorizado.

```text
flag desligada -> menus novos ocultos e endpoints novos bloqueados
inbox API preexistente -> transporte continua sem alteracao
BFF com chave limitada -> onboarding/pair da conta permitidos
chave em outra conta -> 403/404, sem chamada a provider
onboarding aceito -> callback Rails nao encontra transacao longa bloqueando inbox
```

Documentar setup por conta, reemissao de chave, grant, QR expirado, identidade divergente, broker indisponivel, token remoto revogado e recuperacao. Desativar UI por flag não remove webhook/inbox nem faz logout no número. Testar antes de liberar a conta piloto.

- [ ] **Passo 4 - executar novamente o comando, conferir GREEN e realizar os critérios adicionais.**

Executar RSpec dos novos modelos/services/requests/policies, pnpm tests dos novos componentes, lint dos arquivos alterados e build conforme CI real. Registrar bloqueios ambientais. Revisar manualmente desktop/mobile, foco/teclado e traducoes. Conclusão local não autoriza deploy nem atesta número real.

- [ ] **Passo 5 - revisar diff, conferir secrets e registrar commit local.** Fazer stage somente dos arquivos desta tarefa, sem `git add .`.

```bash
git diff --check
git diff --cached --check
git commit -m "test(jrc-broker): validate native control contract"
```

## Gate do plano 02

```bash
bundle exec rspec spec/models/jrc_broker_integration_spec.rb spec/services/jrc_broker spec/requests/api/v1/accounts/jrc_broker_spec.rb spec/requests/api/v1/accounts/jrc_broker_contract_spec.rb
pnpm exec vitest run app/javascript/dashboard/components-next/jrc-broker/__tests__
bundle exec rubocop app/models/jrc_broker_integration.rb app/models/jrc_broker_inbox_binding.rb app/models/jrc_broker_inbox_grant.rb app/services/jrc_broker app/controllers/api/v1/accounts/jrc_broker_controller.rb app/policies/jrc_broker_policy.rb
pnpm exec eslint app/javascript/dashboard/components-next/jrc-broker app/javascript/dashboard/api/jrcBroker.js app/javascript/dashboard/routes/dashboard/settings/inbox/channels/JrcBroker.vue
git diff --check
```

Executar build/CI do checkout real e testes de regressão das partes alteradas. Inicializar rbenv quando aplicavel conforme AGENTS, sem instalar runtimes globalmente em máquina de produção. RAILS_ENV e banco precisam ser inequivocamente de teste. Migração down/destruicao de tabelas não e rollback da feature.
