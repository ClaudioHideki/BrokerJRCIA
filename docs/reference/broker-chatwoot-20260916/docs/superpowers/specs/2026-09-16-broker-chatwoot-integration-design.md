# Arquitetura de integração Broker JRC + Chatwoot

Data: 16/09/2026. Estado: especificação para desenvolvimento; não é software implementado nem homologação de produção.

## 1. Baseline e objetivo

Broker: `ClaudioHideki/BrokerJRCIA`, commit `9e530170cdda90ee8b9b673a28723180e0b2e1a3`.
JRC Conversas: `ClaudioHideki/jrc-conversas-nico-v12-2-7-comercial-integrado`, commit `62c14af884c7f45fa640345556f2ffecc22113d8`.
As revisões foram consultadas no GitHub em 16/09/2026. Ver o inventário de fontes em `docs/validation/2026-09-16-source-evidence.md`.

Objetivo: conectar números empresariais gerenciados pelo broker a caixas API do JRC Conversas e de instalações Chatwoot externas. No JRC, o administrador configura a caixa e o usuário autorizado visualiza o QR dentro da interface. Em terceiros, o portal funciona independentemente do Dashboard App; o app incorporado acrescenta estado e reconexão.

A verificação realizada para este pacote foi leitura de código/documentação. Nenhuma suite dos produtos, dispositivo WhatsApp, implantação ou credencial real foi executada nesta preparação.

## 2. Decisões fechadas

1. Evolução incremental dos dois repositórios; não criar um terceiro broker, gateway de mensagens ou banco compartilhado com o Chatwoot.
2. Manter o broker como proprietário da sessão, identidade do número e entrega pelo provider. Evolution continua privado e acessível somente pelo adapter existente.
3. Manter `Channel::Api` como transporte no Chatwoot. A marca visual JRC não muda o tipo do canal nem finge suporte nativo a todas as capacidades do WhatsApp.
4. Uma organização do broker corresponde a uma conta Chatwoot nesta entrega. Diferentes organizações podem apontar para diferentes instalações. Múltiplas contas por organização ficam fora deste incremento.
5. Preservar unicidade `(base_url, account_id)` e `(organization_id, inbox_id)`. IDs remotos nunca são globais.
6. Uma instância WhatsApp corresponde a uma integração e uma inbox ativa. Não adicionar roteamento de um número para duas plataformas neste incremento.
7. Reutilizar o webhook da caixa: `/v1/integrations/chatwoot/:id/events`. Não duplicar o transporte com webhook de conta, AgentBot ou integração direta Evolution-Chatwoot.
8. Manter as filas, deduplicação, reconciliação e mídia cifrada no PostgreSQL já existentes. Não migrar para MinIO/S3 ou outra fila neste escopo.
9. Separar interfaces de controle da mensageria. Fechar a tela do QR não deve interromper mensagens.
10. O navegador nunca recebe esses segredos em consultas/configurações: token administrativo Chatwoot, chave de plataforma, chave global do engine ou chave permanente do backend. A digitação inicial pelo admin em formulário write-only autorizado é a única exceção de trânsito: transmitir por HTTPS, não persistir no browser e descartar após salvar. O QR é um segredo temporário permitido apenas na tela autorizada.
11. Nenhuma promoção, push, merge, publicação de imagens ou alteração de produção esta autorizada por este pacote. O desenvolvimento ocorre em branches/worktrees isolados.
12. Preservar Meta/Typebot existentes; esta jornada nova de QR usa explicitamente o provider `BAILEYS`. Não confundir o visual de um QR com o tipo de integração.

## 3. Componentes

```text
CONTROLE NATIVO
Vue JRC -> Rails BFF autenticado -> API de controle Broker -> InstanceService -> engine privado

CONTROLE EXTERNO
Portal JRC ou Dashboard App -> autorizacao Broker -> mesma API de controle -> InstanceService

DADOS
WhatsApp <-> engine <-> pipeline Broker <-> ChatwootClient <-> inbox Channel::Api
                                         ^                    |
                                         +-- webhook assinado-+
```

O backend Rails intermediário (BFF) valida a sessão do JRC Conversas e a permissão na conta/inbox. O broker autentica uma chave própria dessa organização e restringe as operações ao vinculo cadastrado. Nenhum JWT de usuário e fabricado pelo Rails.

## 4. Cadastro de destinos externos

Criar `chatwoot_destinations`, tenant-scoped: `organization_id` como PK/FK, `base_url` canônica, `mode` em `MANAGED|EXTERNAL`, `approval_status` em `PENDING|APPROVED|REVOKED`, `media_origins`, `revision`, datas e identificador de auditoria da aprovação.

Preservar `chatwoot_accounts` e seu token cifrado. Acrescentar `credential_version`, `capabilities`, `capabilities_verified_at`. Não recifrar tokens antigos sem necessidade; preservar o contexto criptográfico legado para leitura. Garantir consistencia entre origem de conta e destino por FK composta ou validação transacional equivalente, com teste de violacao.

O administrador da empresa solicita uma origem externa sem fornecer token. O administrador JRC aprova a origem. Somente depois o usuário informa `accountId` e token para validar `/api/v1/profile` e os recursos permitidos. Essa ordem evita enviar credenciais para um destino ainda não aprovado.

Para clientes na JRC, `CHATWOOT_BASE_URL` continua sendo o default do modo `MANAGED`. Para externos, a origem vem do cadastro aprovado da organização. Runtime, worker, download de mídia, reprocessamento e verificações devem usar o mesmo resolvedor. O broker pode operar apenas com externos, sem exigir um `CHATWOOT_BASE_URL` global.

`CHATWOOT_PLATFORM_TOKEN` permanece limitado ao modo `MANAGED` e a origem global configurada. Nunca envia-lo para destinos externos. Cliente com conta existente usa Application API; não exige Super Admin, banco remoto ou Platform App.

Origem/conta com conexões ou trabalhos existentes não pode ser substituida silenciosamente. Retornar `DESTINATION_IN_USE`; uma migração de destino exige procedimento separado. Trocar somente o token da mesma conta e permitido, com validação previa, troca atômica e incremento de versão.

## 5. Requisicoes externas seguras

Aceitar HTTPS e hostname validado, sem usuário/senha embutidos, query, fragmento ou caminho-base. Nesta entrega, HTTPS porta 443; origem em subdiretorio ou porta diferente retorna erro explícito. Localhost/HTTP somente no harness isolado de testes, nunca por flag enviada por cliente.

A aprovação da origem não elimina SSRF: resolver A/AAAA antes de cada nova conexão, validar todos os enderecos e fixar o IP validado no estabelecimento da conexão, preservando hostname/SNI e verificação TLS. Bloquear loopback, privados, link-local, multicast, unspecified e ranges reservados, inclusive IPv4-mapped IPv6. Desabilitar redirecionamentos de requisicoes autenticadas. Não usar apenas `startsWith`, regex de hostname ou uma consulta DNS seguida de outro `fetch` com resolução independente.

Implementar transporte com `node:https`/`dns` e injecao de resolvedor/conector testaveis, ou reutilizar transporte seguro existente comprovadamente equivalente. Não implementar criptografia/TLS própria. Aplicar timeouts e limites de corpo já existentes no cliente.

Anexos: conferir conta/inbox/conversa/mensagem/anexo pela API autorizada antes do download. Liberar apenas origem Chatwoot e origens de mídia aprovadas daquela organização. Não repassar `api_access_token` para CDN ou redirecionamento. Reaplicar controles de rede a cada destino permitido.

## 6. Credenciais e permissões de controle

Reutilizar emissão/verificação HMAC de API keys do broker. Adicionar escopos novos e exclusivos:

```text
chatwoot:read
chatwoot:manage
chatwoot:pair
chatwoot:disconnect
```

Criar `chatwoot_control_bindings`: chave existente -> organização -> conta -> revisão do destino. Vinculos e FK devem impedir uma chave de empresa A ligada a recursos da B. A chave do Rails não recebe `instances:write`, nem autorização de mensageria, nem acesso a administracao global.

As rotas existentes da console mantem seu comportamento JWT. Novas rotas de controle aceitam chave específica vinculada ou JWT do portal com verificação equivalente. Não remover o guard atual de `integrations.ts` para liberar toda a API a qualquer chave.

O broker resolve empresa pelo principal autenticado e verifica integração/inbox/instância armazenadas. Não confiar em `organizationId`, `accountId`, origem ou papel enviados no corpo. Dados do ator externo para auditoria são gerados no Rails a partir da sessão e registrados como atribuição da chave emissora, não como identidade JWT do broker.

| Perfil | Estado | Criar/vincular caixa | QR/reconectar | Desconectar/trocar número |
|---|---|---|---|---|
| Admin da conta | Sim | Sim | Sim | Sim, com confirmação |
| Agente da inbox sem delegacao | Sim | Não | Não | Não |
| Agente da inbox com delegacao | Sim | Não | Sim, na inbox autorizada | Não |
| Usuário de outra conta | Não | Não | Não | Não |

No Rails, criar concessão específica por conta/usuário/inbox; revalidar filiações e concessão a cada chamada. No portal/app externo, a concessão e para uma identidade autenticada do broker. Para usuários externos restritos, usar `VIEWER` mais concessão específica; o papel legado `OPERATOR` já possui poderes mais amplos de instância e não deve ser usado como se fosse restrito apenas ao app.

Revogar chave/concessão/sessão, suspender empresa ou remover usuário da inbox deve bloquear a próxima operação. Nenhum cache permissivo de autorização em mutacoes.

## 7. API nova de controle (contrato proposto, não existente)

Prefixo: `/v1/integrations/chatwoot/control`.

| Método/caminho | Efeito | Escopo |
|---|---|---|
| `GET /context` | Conta e capacidades sanitizadas | `chatwoot:read` |
| `POST /onboarding` | Iniciar criação/vinculo persistente | `chatwoot:manage` |
| `GET /onboarding/:operationId` | Ler andamento/resultado | `chatwoot:read` |
| `GET /connections/:integrationId/status` | Estado sem QR | `chatwoot:read` |
| `POST /connections/:integrationId/pair` | Solicitar QR ou pareamento existente | `chatwoot:pair` |
| `POST /connections/:integrationId/disconnect` | Logout explícito | `chatwoot:disconnect` |
| `PUT /connections/:integrationId/agents` | Associar agentes válidos | `chatwoot:manage` |

Mutacoes exigem `Idempotency-Key`. Nomes de negócio `integrationId`, `instanceId`, `inboxId` não são intercambiaveis. A resolução e por mapeamento persistido, nunca por nome da instância.

Entrada de onboarding:

```typescript
type OnboardingInput = {
  name: string;
  source:
    | { kind: 'EXISTING'; instanceId: string }
    | { kind: 'NEW'; instanceName: string; providerAccountId: string };
  inboxId?: number;
  agentIds: number[];
  replaceExistingWebhook: boolean;
};
```

Retorno do onboarding: `operationId`, `state`, `stage`, `integrationId|null`, `instanceId|null`, `inboxId|null`, `lastError|null`. Não incluir token, QR ou segredo na operação persistida.

Retorno de pair: reutilizar `ConnectionResponseSchema`, incluindo `action.type`, `encoding`, `value` e `expiresAt`. Não criar um endpoint ficticio `GET /qrcode` nem armazenar o QR em atributos da inbox. `GET status` não inicia uma conexão.

Status composto:

```typescript
import type { InstanceStatus } from '@jrc/contracts';

type ConnectionHealth = {
  integrationId: string;
  inboxId: number | null;
  instanceId: string;
  integrationStatus: 'PENDING'|'READY'|'FAILED'|'UNKNOWN'|'DISABLED';
  instanceStatus: InstanceStatus;
  callbackVerifiedAt: string | null;
  lastSuccessfulInboundAt: string | null;
  lastSuccessfulOutboundAt: string | null;
  transportStatus: 'UNVERIFIED'|'OPERATIONAL'|'DEGRADED';
  checkedAt: string;
  lastError: string | null;
  allowedActions: ('status'|'pair'|'disconnect'|'manage')[];
};
```

`OPERATIONAL` exige vinculacao pronta, número conectado, assinatura recebida para a revisão atual e evidência recente de transporte nos dois sentidos sem falha ativa. Nesta entrega, evidência de transporte e recente por 24 horas; depois volta a `UNVERIFIED` sem impedir envio. Não enviar mensagens de teste automaticamente a clientes para renovar esse indicador. Sem trafego, exibir configuração/conexão e informar transporte ainda não validado.

## 8. Onboarding persistente e limites transacionais

Criar operação em `chatwoot_onboarding_operations`, única por `(organization_id, idempotency_key)`, com hash canônico do input e revisão do destino. Mesma chave/input retorna mesma operação; mesma chave/input diferente retorna 409.

```text
INSTANCE -> ACTIVATE_CHANNEL -> LINK_INBOX -> ASSIGN_AGENTS -> VERIFY -> DONE
Estados: PENDING, RUNNING, FAILED, UNKNOWN, SUCCEEDED
```

Reutilizar `InstanceService.createInstance`, ativação QR, `ChatwootService.connect` e associação de agentes existentes. Persistir cada ID retornado antes da próxima etapa. Reutilizar integração existente em retries. Broker e o único autor da inbox durante esse fluxo; Rails não deve cria-la também.

Não manter transação Rails aberta aguardando o broker: o broker chama a API do próprio Rails para criar a inbox. O BFF inicia a operação e acompanha seu ID. Não manter transação PostgreSQL do broker aberta durante requisicao externa.

Timeout depois de POST remoto e `UNKNOWN`, não autorização para repetir cegamente. Conciliar pelos IDs/callback exclusivo; resultado inconclusivo exige intervenção autorizada. Cancelamento pausa/abandona a operação sem excluir inbox com histórico, número conectado ou sessão preexistente.

## 9. Jornada nativa JRC Conversas

Adicionar a opcao visual `WhatsApp - JRC Broker` em Caixas de entrada, com componente próprio e feature flag. Internamente o canal continua `Channel::Api`.

Configurar uma vez, por conta: origem fixa/autorizada do broker e chave de controle dessa conta. Guardar cifrada no servidor Rails com chave dedicada de ambiente e contexto criptográfico ligado a conta. Não colocar credenciais em `window.chatwootConfig`, props, `additional_attributes`, query string ou armazenamento do navegador.

Modelos novos: `JrcBrokerIntegration` (configuração da conta), `JrcBrokerInboxBinding` (mapeamento local) e `JrcBrokerInboxGrant` (delegacao de reconexão). Mapeamento local não substitui a verificação do broker.

Rotas propostas Rails:

```text
GET/PUT /api/v1/accounts/:account_id/jrc_broker
POST    /api/v1/accounts/:account_id/jrc_broker/onboarding
GET     /api/v1/accounts/:account_id/jrc_broker/onboarding/:operation_id
GET     /api/v1/accounts/:account_id/inboxes/:inbox_id/jrc_broker/status
POST    /api/v1/accounts/:account_id/inboxes/:inbox_id/jrc_broker/pair
POST    /api/v1/accounts/:account_id/inboxes/:inbox_id/jrc_broker/disconnect
PUT     /api/v1/accounts/:account_id/inboxes/:inbox_id/jrc_broker/grants
```

Reutilizar `Api::V1::Accounts::BaseController`, autenticação/CSRF existentes e policies. No seletor/configurações: admin gerencia. No cabeçalho da conversa: status e reconexão para agente delegado, sem abrir a página administrativa.

QR: manter somente em memoria, respeitar `expiresAt`, limpar em troca de conta/inbox, desmontagem, logout e conexão confirmada. Atualizar status a cada 3 segundos enquanto a tela estiver visível; aplicar recuo até 15 segundos em falhas. Renovar o QR por nova intencao com nova chave idempotente, não por polling de `POST pair`.

Reconectar número diferente do anteriormente confirmado deve manter o transporte bloqueado e exigir aprovação administrativa. Confirmar identidade no retorno autenticado do provider antes de liberar mensagens; escanear QR não e autorização para trocar o número da empresa. Primeira vinculacao e administrada pelo admin. O bloqueio de identidade deve ser aplicado no pipeline antes do despacho, não apenas na UI. Antes de iniciar pair, revalidar o acesso remoto da integração via API; 401/403 ou indisponibilidade bloqueiam a nova ação sem apagar a sessão existente.

Preservar Vue Composition API, Tailwind e i18n/branding do repo. As regras atuais restringem alteração de strings-fonte a ingles; seguir o pipeline existente para pt-BR, sem hardcode em templates ou edicao indiscriminada de traducoes geradas. A homologação da experiencia em português depende também dessa etapa.

## 10. Portal e Dashboard App externo

O portal deve funcionar antes e independentemente do iframe. A primeira conexão não depende de uma conversa já aberta.

Criar app por conta com `embedId` aleatório público e rota `/embed/chatwoot/:embedId`; o registro resolve organização, conta e revisão de destino. E opcional cadastrar automaticamente um Dashboard App quando o destino comprovar suporte. No fork analisado, o payload e `dashboard_app: { title, content: [{type:'frame', url}] }`; não extrapolar esse contrato sem teste para outras versões. Sempre oferecer nome/URL para cadastro manual.

Manter `/jrc`, `/login`, console e demais páginas com `frame-ancestors 'none'` e `X-Frame-Options: DENY`. Somente a rota embed recebe `frame-ancestors` da origem exata autorizada e remove XFO conflitante. Não aceitar parâmetro `origin` como fonte de confiança. Não liberar CORS global. Falha no lookup da origem bloqueia o embed.

`postMessage` serve somente para sugerir inbox/conversa. Validar `event.origin` e `event.source === window.parent`, schema e tamanho; ignorar contexto de outra conta. Não autorizar pelo e-mail/papel/ID de `currentAgent`. Não enviar QR ou token ao parent.

Autenticação sem dependência de cookies de terceiros:

1. Iframe cria um verificador aleatório em memoria e envia apenas seu desafio SHA-256 para iniciar uma autorização de 120 segundos, vinculada ao `embedId`.
2. Abre página first-party do broker com ID público da solicitacao. O usuário autentica no broker e confirma a conta/inboxes/ações permitidas. Essa página não pode ser incorporada.
3. O iframe troca a solicitacao aprovada apresentando o verificador. Troca atômica, de uso único. Requisicao ainda não aprovada retorna estado pendente, não sessão.
4. Recebe sessão opaca, curta (5 minutos), somente em memoria, vinculada a usuário, organização, embedId, revisão do destino e integrações concedidas. Token armazenado como hash no servidor.
5. Sessão permite apenas estado e pair autorizado; não permite mensageria, criar empresas, mudar token nem desconectar. Expiracao exige nova autorização, com alternativa de abrir o portal.

Esse e um handshake específico deste produto, não uma alegacao de OAuth/SSO nativo do Chatwoot. Usar primitives WebCrypto/node:crypto e autenticação existente, com revisão de segurança. Se popup/sandbox impedir o fluxo, oferecer abertura first-party do portal sem reduzir controles. Revalidar concessão e empresa a cada operação, inclusive após emissão da sessão.

## 11. Eventos, evidências e compatibilidade

Reutilizar corpo bruto e HMAC existente (`timestamp + '.' + raw_body`), tolerância temporal já implementada e segredo da própria inbox. Não usar `hmac_token` de identidade de contato como segredo do webhook. `delivery_id` e rastreamento, não chave única suficiente para deduplicar mensagem de negócio.

Verificar conta e inbox do evento contra o mapeamento. Deduplicar por organização/integração/ID remoto/semântica do evento. Notas privadas, entrada e eco não geram saida. Respostas públicas de automacao/bot só seguem a política já acordada; não proibir todos os bots nem autorizar todos por nome do remetente.

Capacidades devem distinguir `SUPPORTED`, `UNSUPPORTED`, `UNVERIFIED`. Ler perfil não prova escrita, assinatura nem trafego. Número de versão informado e diagnóstico; a homologação usa contrato observado. Instalação sem segredo/assinatura compatível fica bloqueada para este conector, sem fallback unsigned.

Uma fila duravel no broker protege eventos já aceitos; não prova que eventos perdidos antes da persistencia serão reenviados pelo Chatwoot. Testar indisponibilidade nessa fronteira. Ausência de retry/recuperacao comprovados e bloqueio de homologação de entrega confiável, não motivo para declarar exatamente uma vez. A estrategia de recuperacao dessa fronteira deve ser registrada no piloto; não alterar webhooks globais do cliente sem autorização.

## 12. Flags, entrega e rollback

Broker: `CHATWOOT_EXTERNAL_DESTINATIONS_ENABLED`, `CHATWOOT_CONTROL_API_ENABLED`, `CHATWOOT_EMBED_ENABLED`, inicialmente falsas. JRC: `JRC_BROKER_NATIVE_ENABLED`, com liberação por conta e feature flag desligada por padrão.

Cada flag controla a superficie nova, não apaga registros nem interrompe o transporte legado. Desligar UI/control não deve desligar o webhook nem esvaziar filas. Migrações aditivas devem permitir desativação das features sem down destrutivo.

Antes de voltar binario antigo do broker: pausar e drenar/quarentenar trabalhos EXTERNAL, pois o binario anterior conhece apenas uma origem. Manter o ultimo worker compatível para esses tenants ou suspende-los explicitamente. Não presumir rollback global seguro apenas porque o schema e aditivo.

Aceite final: matriz em `docs/validation/2026-09-16-integration-acceptance.md`. Entrega deve separar testes locais, integração real com Chatwoot e piloto com telefone autorizado. Sem credenciais, finalizar código/testes sintéticos possiveis e listar homologação externa como bloqueada; jamais inventar resultado.
