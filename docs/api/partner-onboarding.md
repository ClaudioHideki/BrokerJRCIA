# API JRC para CCLX e outros sistemas

O consumidor recebe a origem HTTPS do Broker e uma chave exclusiva da organização.
Não é necessário fornecer URL, Account ID ou token do Chatwoot para emitir a chave,
criar uma instância QR, ativar seu canal, consultar ou enfileirar texto e anexos individuais.
O tenant é inferido da chave. Nunca envie `organizationId` para escolher outra empresa.

## Escopo desta entrega

* Conexão: listar, criar, parear, consultar e desconectar instâncias.
* Mensageria do parceiro: ativar canal QR, ler canais/conversas/mensagens, carregar anexos privados e enviar texto ou mídia individual por referência.
* Recebimento: eventos persistidos de mensagem/estado/conexão; polling e webhook HTTPS assinado.
* Portal público: `/documentation/`, contratos OpenAPI filtrados e consultas Postman sem credenciais.
* Chaves: escopos explícitos, prazo de validade, revogação e revalidação antes do despacho de mensagens.

O download privado exige `messaging:read`. Upload e consulta de metadados exigem
`media:upload`; envio por referência exige `messaging:send` e `media:send` juntos.
Chaves antigas não recebem os novos escopos automaticamente. O perfil genérico
**não inclui grupos, templates Meta ou gestão de Flows**. Essas funções têm
caminhos existentes com outros contratos/permissões e não foram
convertidas em acesso genérico nesta entrega. A integração direta Chatwoot continua
opcional e usa sua própria credencial vinculada à Account remota.

## Vínculo direto e primeira identidade QR

O controle usa a origem HTTPS aprovada, Account e revisão vinculadas à chave de
controle; consultar `/control/context` e `/control/resources`. A mesma credencial
da empresa atende seus vínculos autorizados, sem emissão por caixa. Isso é
separado de criar uma instância com a chave genérica e de sincronizar o catálogo
local do host. Flow mantém sua credencial e contrato próprios.

Somente um vínculo BAILEYS **novo**, criado com intenção autenticada de
administrador/`chatwoot:manage`, é elegível à matrícula automática da primeira
identidade. A criação pode concluir a matrícula se a instância já estiver
conectada. Para QR novo, o POST administrativo de `pair` arma uma janela de até
dois minutos, limitada pelo desafio e pelo prazo de criação de 24 horas. Replays
idempotentes não ampliam o prazo. Contexto, autoridade, primeira observação válida,
revisão, inbox API, callback e segredo são conferidos novamente antes da matrícula.

GET nunca aprova identidade. Vínculos legados, prazo expirado e troca de número
mantêm confirmação administrativa da `observedRevision` atual. Revogação, logout
ou mudança de contexto/identidade bloqueiam a intenção. Um novo POST administrativo
pode rearmar somente enquanto ainda elegível; identidade aprovada nunca é trocada
automaticamente. Meta segue seu onboarding próprio.

`SUCCEEDED` do onboarding e `READY` do vínculo representam configuração;
`CONNECTED` é sessão. Consultar saúde e `campaign-transport.ready/reason` antes de
considerar capacidade de campanha. Matrícula não ativa bot, não certifica callback
recebido/entrega nem instala/homologa o CCLX. Consulte o [runbook de controle](../operations/chatwoot-external.md).

## Provisão pela JRC

1. Criar/selecionar a organização contratada no console do Broker.
2. Em Chaves de API, emitir chave com `instances:read`, `instances:write`,
   `messaging:read`, `messaging:send` e `webhooks:manage`. Se a integração usar anexos,
   selecionar também `media:upload` e `media:send`. Para POC, usar validade de 15 dias.
3. Entregar por canal privado a origem e a chave. Não colocar a chave em URL,
   repositório, pacote de documentação, print ou frontend público do CCLX.
4. O backend do CCLX guarda a chave e atende seu próprio frontend com a sessão e
   permissões locais. Agentes não recebem a chave administrativa do tenant.
5. Quando o CCLX disponibilizar um endpoint HTTPS público, registrar o webhook.
   Sem endpoint, consultar eventos por cursor. O token de API e o segredo HMAC são distintos.

Uma chave antiga de `api_keys:manage` não pode delegar os novos escopos que não possui.
OWNER/ADMIN pode emiti-los; chaves delegadas precisam ter todos os escopos de parceiro solicitados.

## Sequência de uso

Consulte schemas e exemplos reais no Swagger; IDs abaixo são os retornados pela API.

1. `GET /v1/provider-accounts?provider=BAILEYS&limit=100`: escolher uma conta do tenant e guardar `data[].id` como `providerAccountId`. Se não houver conta disponível, a JRC precisa provisionar o acesso antes da criação. Não usar ID/chave do motor Evolution.
   Depois, `POST /v1/instances` com `{ "name": "POC CCLX", "provider": "BAILEYS", "providerAccountId": "UUID_OBTIDO" }` e `Idempotency-Key`.
2. `POST /v1/instances/{id}/connect`; mostrar o QR retornado somente ao operador autorizado.
3. Consultar `GET /v1/instances/{id}/status` até confirmar a conexão.
4. `POST /v1/messaging/instances/{id}/partner-activate` com `{}` e chave idempotente.
   Exige `instances:write` **e** `messaging:send`. Guardar `response.id` como `channelId`; a resposta do canal é um objeto plano.
5. `POST /v1/partner-webhooks` com `{ "url": "https://seu-backend.example/hooks/jrc" }`
   e uma chave idempotente. Guardar o `signingSecret` no backend consumidor.
6. Enviar uma mensagem de um número de homologação ao número conectado; conferir
   `message.received` no webhook e/ou `GET /v1/partner-events?after=0&limit=50`.
7. Responder com `POST /v1/messaging/channels/{id}/partner-text`, corpo
   `{ "conversationId": "ID_RETORNADO", "text": "Texto de teste" }` ou
   `{ "phoneNumber": "+E164", "text": "Texto de teste" }`, nunca ambos.
8. Guardar o ID retornado e consultar mensagens/eventos até o estado final.
   **202 confirma enfileiramento, não entrega.** Repetir a mesma intenção com a
   mesma chave idempotente. `UNKNOWN` exige conciliação, sem forçar um novo envio.

O envio do operador assume a conversa em modo humano antes de enfileirar. O Broker
revalida a chave no despacho: expirada, revogada, apagada ou sem escopo bloqueia o
envio pendente. A ativação do canal não publica nem ativa bots automaticamente.

### Upload e envio de anexos

1. `POST /v1/messaging/channels/{id}/media`: corpo binário `application/octet-stream`,
   `Idempotency-Key` UUID e headers `X-JRC-Media-Mime`, `X-JRC-Media-Kind` e
   `X-JRC-Media-Name` (nome codificado com `encodeURIComponent`). O arquivo deve ter
   assinatura compatível com MIME/tipo; limite geral de 16 MiB, imagens até 5 MiB.
2. Guardar `id`, `status` e o header `Location` da resposta 201. **Upload não envia
   mensagem.** Se o estado for `STORING`, consultar
   `GET /v1/messaging/channels/{id}/media/{mediaId}` até `READY` ou `FAILED`.
   Resultado incerto deve ser reconciliado; não repetir com uma nova chave para
   forçar outro PUT.
3. Somente com `READY`, chamar `POST /v1/messaging/channels/{id}/partner-media` com
   outra `Idempotency-Key` e `{ "conversationId": "UUID", "mediaId": "UUID", "caption": "Legenda" }`
   ou `phoneNumber` E164 em lugar de `conversationId`, nunca ambos. Legenda opcional
   de até 1.024 caracteres; nome, tipo e MIME vêm do arquivo validado.
4. Acompanhar a mensagem retornada por consultas/eventos. 202 significa fila;
   estados e recibos posteriores comprovam o avanço. Mesma intenção usa a mesma
   chave; conteúdo/metadados divergentes retornam 409.

O arquivo só pode ser usado no mesmo tenant/canal QR aberto. Uma chave atual com
escopos suficientes pode usar a referência após rotação da chave que fez o upload;
isso não amplia acesso entre canais ou empresas. Os exemplos executáveis estão
na coleção `postman-media.json`, com upload e envio desabilitados por padrão.

Receba webhooks como documentado em [partner-webhooks.md](partner-webhooks.md):
HMAC com corpo bruto, janela de timestamp, deduplicação durável por `eventId` e
resposta 2xx somente depois de persistir. Há tentativas e possível entrega fora de
ordem. Polling tem retenção de 30 dias; cursor expirado retorna 409 com metadados de
recuperação. Revogar chave de API não revoga o endpoint: revogue ambos no encerramento.

## Módulo QR dentro do CCLX/JRC

O pacote `integrations/partner-qr` fornece painel e adaptador de conexões para o
backend do host. O CCLX precisa implementar os hooks de sessão, CSRF, cofre e
permissões antes de montá-lo. Ele não instala controller Rails nem mensageria.
Uma camada adicional precisa converter os eventos em contatos, conversas e
mensagens locais, mantendo vínculo único entre canal JRC e caixa local. As saídas
do compositor local precisam de idempotência; eventos espelhados não podem gerar
novo envio. A exibição de anexos deve revalidar as permissões locais.

O contrato genérico não depende da URL do Chatwoot. A instalação nativa ainda exige
conhecer a versão e os pontos de extensão do CCLX. Tela de QR, adaptador e integração
de Flow são entregas separadas da emissão de chave. Não trocar a integração atual
do Grupo JRC por esse adaptador sem homologar entrada, saída, mídia, estados e transferência.

### Flow, times e agentes no CCLX

Os quatro eventos genéricos documentados são de mensagem, estado e conexão.
Eles não atribuem conversas a times/agentes nem executam comandos de Flow no
CCLX. O cadastro da chave e o pareamento QR não implementam uma URA local.

Há dois percursos que não devem ser confundidos: o consumo genérico transporta
mensagens e eventos; a integração direta Chatwoot usa uma Account remota vinculada
e contratos próprios de controle/delegação. Para usar transferência e retomada do
Broker dentro do CCLX, é necessário homologar essa ponte de controle e os pontos
de extensão da versão instalada, ou desenvolver um protocolo próprio de comandos
com confirmação durável. Não enviar comandos de atribuição como se fossem texto.

Começar pelo editor no console Broker, com um executor por canal. A incorporação
do editor no CCLX exige instalação adicional com sessões delegadas, recursos
autorizados, catálogo local e confirmação de transferência/retomada. Esses testes
não estão cobertos pela coleção POC genérica de 19 operações.

## Atualização do servidor Broker

Usar o Compose completo `infra/dokploy/compose.yaml`. `infra/app/compose.yaml` é uma
base antiga de desenvolvimento e seu perfil adicional só inicia o worker de eventos.

1. Atualizar API e web para os digests verificados **do mesmo commit**. Todos os
   workers existentes que usam `JRC_API_IMAGE` devem acompanhar a atualização.
   Conferir os containers efetivos e aguardar a saída dos workers antigos antes
   de emitir as chaves da POC; alterar o ENV sozinho não recria processos.
2. Gerar uma única chave dedicada no terminal confiável:
   `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`.
   Salvar em `PARTNER_WEBHOOK_ENCRYPTION_KEY`; preservar nos próximos deploys.
   Nunca compartilhar essa chave com o CCLX. API e worker devem receber o mesmo valor.
3. Aplicar migrações pelo serviço `migrate` do perfil `maintenance`, com banco ativo.
   As novas migrações são `0070_partner_events`, `0071_partner_messaging_authority`
   `0072_chatwoot_campaign_intents`, `0073_chatwoot_initial_identity` e
   `0074_partner_media`. A última preserva uploads legados e reforça o controle
   de autoridade de mídia inclusive em workers anteriores.
4. Habilitar `COMPOSE_PROFILES=partner-api` (preservando outros perfis já configurados)
   e fazer o Deploy normal com Run Command vazio. O novo `partner-events-worker`
   precisa de saída HTTPS; o Compose o liga às redes backend e egress.
5. Conferir `operational-status.js`: READY, baseline
   `0074_partner_media`, schema compatible. Isso é evidência estrutural,
   não comprova entrega ao WhatsApp ou ao consumidor externo.
6. Abrir `/documentation/` sem login, confirmar contratos e Authorize. O portal
   deixa escrita bloqueada até seleção explícita na aba; nenhuma requisição de
   negócio é disparada automaticamente. Confirmar `/ready` como JSON do backend.
7. Conferir logs do novo worker e executar a POC com números de homologação.

No serviço Broker do Dokploy conferido em 22/10, o projeto Compose é
`jrc-broker-broker-ophydn`, a branch é `main` e o caminho é
`./infra/dokploy/compose.yaml`. Depois de definir os digests da revisão aprovada,
usar temporariamente em Advanced → Run Command:

```sh
docker compose -p jrc-broker-broker-ophydn -f ./infra/dokploy/compose.yaml --profile maintenance run --rm migrate
```

Fazer Deploy e conferir o log do provisionador até saída zero. Depois apagar o
Run Command, salvar e fazer o Deploy normal. O comando acima é do Dokploy/host;
não deve ser colado no shell dentro do container API. Nesse container, a leitura
estrutural é:

```sh
node /app/apps/api/dist/commands/operational-status.js
```

Não alterar domínios, caixas, tokens Meta, credenciais Chatwoot nem ativar bots para
publicar esta entrega. Não executar `docker compose down --volumes`. Migrações
aditivas não dispensam conferir o resultado e a compatibilidade do banco existente.

### Campanhas na integração direta Chatwoot/JRC

O transporte `chatwoot-campaigns/v1` mantém as consultas de capacidade e recibos
da versão anterior. A revisão atual acrescenta reserva da mensagem canônica:
`POST .../connections/{integrationId}/campaign-intents`, com chave vinculada à
integração, escopo `chatwoot:manage`, `X-JRC-External-Actor` e idempotência.
Não usar a chave genérica da POC para esse contrato.

O host grava a mensagem local, reserva a intenção e somente então libera seu
callback assinado habitual. A reserva confere conta, caixa, administrador,
destinatário, conteúdo, anexos e revisões. Ela não muda o proprietário da conversa
nem ativa ou pausa um bot. Incompatibilidade ou resultado incerto bloqueia o envio.
Uma conversa remota que conflita com outro ciclo físico exige conciliação humana.

Publicar primeiro o Broker com a migração 0072 e todos os workers compatíveis;
depois atualizar Rails e Sidekiq para a mesma revisão candidata do JRC. O módulo
QR genérico não instala automaticamente esse hook em outro Chatwoot. O CCLX
precisa homologar seu próprio adaptador antes de habilitar campanhas por essa via.

### Reversão e troca de workers

A migração 0071 conserva a identidade da chave na mensagem e exige autoridade
válida no banco em toda transição para `SENDING`, inclusive `SENDING` para
`SENDING`. Isso bloqueia uma chave revogada, expirada, removida ou sem escopo mesmo
quando um worker anterior tenta despachar a mensagem. Mensagens legadas sem
identidade de chave mantêm o caminho anterior. Uma requisição já enviada ao
provedor não pode ser desfeita revogando a chave.

Se houver reversão de imagem, pausar novas chamadas do parceiro e o worker de
eventos, conferir mensagens pendentes/incertas e manter as migrações aditivas.
Não remover a coluna, o trigger de autoridade nem as tabelas de eventos como
forma de rollback. Validar o conjunto API/workers antes de retomar a POC; um
servidor com imagens misturadas não equivale à revisão homologada.

## Aceite da POC

Provar primeiro um número: pareamento, entrada, resposta, estados, repetição com
mesma chave, revogação, indisponibilidade do consumidor e retomada, isolamento de
outro tenant. Depois expandir até cinco números e iniciar os quinze dias acordados.
Os testes automatizados e a imagem publicada não substituem esse aceite externo.
