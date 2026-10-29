# Integração Broker JRC: API de parceiro e integração direta

Base histórica: `16a2a371e44de65a901cf1a9405bf4939ee1f213`; revisão candidata de
29/10/2026 na branch `codex/broker-experience-20261029`, incluindo mídia de parceiro.
Este documento descreve contratos implementados e limites observados. Não habilita
consumidores nem altera conexões existentes. Consulte também
[onboarding de parceiro](partner-onboarding.md), [eventos](partner-webhooks.md) e
[baseline de autorização e mídia](../validation/2026-10-29-api-baseline.md).

## Modos e responsabilidades

| Responsabilidade | Modo A: backend do parceiro consome API JRC | Modo B: integração direta Chatwoot/JRC |
| --- | --- | --- |
| Tenant e credencial | Organização e API key próprias por parceiro/empresa; tenant inferido da chave | Organização Broker e credencial de controle vinculada à origem/Account/revisões |
| Dados necessários para emitir acesso | URL Broker, scopes e política de chave; não exige URL, Account ID ou token Chatwoot | Destino HTTPS aprovado, Account, credencial remota e vínculos explícitos de inbox |
| Segredo no host | Cofre do backend; BFF aplica sessão, CSRF, membership e ações do usuário | Credenciais server-side e grants/sessões específicos; não expor chave administrativa no widget |
| Caixa local | Adapter do host cria/seleciona e persiste binding canal Broker → inbox; ativar canal Broker não cria inbox local | Reutilizar provisionamento/adoção/onboarding existentes e reconciliação por operação |
| Entrada e projeção | Host persiste eventos/inbox com dedupe e projeta mensagens/status/mídia | Worker Broker espelha na Account/inbox vinculadas, conservando IDs remotos e antieco |
| Saída | Host chama contrato público com idempotência; Broker grava outbox e despacha | Webhook assinado e controle de transporte determinam o único responsável pelo envio |
| Recebimento | Endpoint HTTPS autorizado ou polling com cursor/retention | Webhooks e callbacks específicos da integração, sem substituir silenciosamente vínculos |
| Atendimento/Flow | Requer contrato adicional; eventos de mensagem não atribuem agente/time | Catálogo, revisão de vínculo, grants, handoff e retomada próprios precisam de homologação conjunta |

Os modos não são nomes novos de enum persistido. `BROKER_TRANSPORT` e
`CENTRAL_TRANSPORT` são outra dimensão: indicam quem envia fisicamente. Um canal
precisa de um proprietário de envio e um de projeção. Ativar dois caminhos para a
mesma inbox exige proteção explícita de duplicação e autoridade; não é uma mudança
automática desta documentação.

## Operações públicas genéricas desta revisão

O gerador `scripts/docs/public-api.mjs` seleciona estas operações do OpenAPI real.
Exemplos usam placeholders; nenhuma chamada é executada ao ler o portal.

| Perfil | Operações |
| --- | --- |
| Instâncias (7) | GET `/v1/provider-accounts`; GET/POST `/v1/instances`; GET `/v1/instances/{id}`; POST `.../{id}/connect`; GET `.../{id}/status`; POST `.../{id}/disconnect` |
| Mensageria (10) | POST `/v1/messaging/instances/{id}/partner-activate`; GET `/v1/messaging/channels`; GET `/v1/messaging/channels/{id}/conversations`; GET `/v1/messaging/conversations/{id}`; GET `.../{id}/messages`; GET `/v1/messaging/media/{id}`; POST `/v1/messaging/channels/{id}/partner-text`; POST `.../{id}/media`; GET `.../{id}/media/{mediaId}`; POST `.../{id}/partner-media` |
| Eventos (5) | GET/POST `/v1/partner-webhooks`; DELETE `/v1/partner-webhooks/{id}`; GET `/v1/partner-events`; GET `/v1/partner-webhook-deliveries` |

Consultas de instâncias usam `instances:read`; alterações usam `instances:write`.
Ativação exige também `messaging:send`. Consultas de mensageria e bytes exigem
`messaging:read`; texto de parceiro exige `messaging:send`. Upload e seus metadados
exigem `media:upload`; envio de referência exige `messaging:send` e `media:send`.
Eventos e endpoints
exigem `webhooks:manage`. O issuer genérico também reconhece `api_keys:manage`,
mas gestão de chaves não integra estes três perfis publicados. Uma chave emissora
não pode delegar novos scopes de parceiro que não conserva atualmente.

O texto público atual é individual, QR/`BAILEYS`, pelo `BROKER_TRANSPORT`, com
conversa do mesmo canal ou destinatário E164. `Idempotency-Key` é obrigatório.
202 confirma fila; `SENT`, `DELIVERED` e `READ` dependem de fatos posteriores.
`UNKNOWN` exige reconciliação. API key revogada/expirada ou sem scope bloqueia
despacho pendente; revogação não desfaz request já enviado ao provider.

Upload privado retorna 201 com estado explícito e não envia. O parceiro consulta
metadados até `READY`, então admite a referência na outbox por POST `partner-media`.
Ambos os POSTs têm idempotência independente; um resultado incerto não autoriza
novo efeito físico. Mídia permanece restrita ao mesmo tenant/canal QR e a chaves
com autoridade atual. Não há ampliação automática das chaves existentes.

**Ainda não contratados pelo perfil genérico:** mensagens de grupo,
templates/envio Meta e gestão/publicação de Flows. Adapters internos e
endpoints JWT existentes não delegam automaticamente essas capacidades. GET
privado de mídia já existe e deve continuar protegido durante toda a leitura.
O catálogo publicado também não equivale à allowlist de autenticação: conferir os
guards reais ao definir ou restringir o acesso de cada chave.

## Controle direto e Flow

O quarto perfil público contém 15 operações de controle Chatwoot: contexto,
recursos, onboarding (consulta/início/operação/recuperação), status de conexão,
pareamento e sua operação, confirmação de identidade, desconexão, agentes,
capacidade de campanhas, reserva de campaign-intents e consulta de recibo de
campanha. O prefixo é `/v1/integrations/chatwoot/control`.

`PUT /connections/{integrationId}/agents` recebe o conjunto completo em
`agentIds`: IDs ausentes são retirados da caixa, e `[]` remove todos os vínculos
de agentes dessa caixa, sem excluir os usuários. O Broker confere o conjunto
observado antes de concluir a intenção. Se o resultado permanecer incerto,
reconcilie antes de emitir outra tentativa. O POST administrativo legado e a
etapa de agentes do onboarding conservam a semântica de adição.

A chave específica usa `chatwoot:read`, `chatwoot:manage`, `chatwoot:pair` e/ou
`chatwoot:disconnect`, vinculada à Account/origem/revisão; o issuer genérico não
emite esses scopes. O ator externo e sua autoridade são verificados nos contratos
que os exigem. QR/texto não concede autoridade universal ao editor Flow.
`/v1/delegated-flows` usa autorização própria. Reutilizar contratos de delegação,
grants, revisão e sessão curta/revogável ao incorporar o editor.

`integrations/partner-qr` é referência Node para painel/BFF e exige integração
real da sessão, CSRF e permissões do host. Não é instalador Rails completo nem
implementa inbox/outbox/status/mídia local. A versão e customizações CCLX ainda
precisam ser identificadas no ambiente alvo antes do aceite de instalação.

## Eventos, mídia e recuperação

Eventos do parceiro possuem segredo HMAC separado da API key, timestamp,
`eventId`, persistência durável e tentativas limitadas. O host verifica corpo bruto,
deduplica antes de confirmar e preserva estados mais recentes. Polling mantém
30 dias; cursor expirado retorna 409 e exige reconciliação pelo histórico Broker.
Revogar a chave não revoga o endpoint automaticamente: encerrar ambos.

O Broker conserva metadados de mídia por tenant e bytes privados cifrados em
PostgreSQL ou backend S3 configurado. Mudar ENV não migra arquivos históricos.
GET usa proxy autenticado e revalidação antes de liberar bytes. O host precisa
definir se copia para seu Active Storage ou referencia o Broker, como revalida a
membership local, quanto retém e como revoga acesso. Compartilhar bucket não
compartilha autorização nem tabelas entre Broker e Rails.

## Aceite por ambiente

Antes de habilitar o consumidor: confirmar versões/SHAs/digests, schema, workers,
HTTPS, relógio, callback, binding e uma autoridade de envio/projeção por inbox.
Homologar duas empresas e identificadores locais colidentes; texto e mídia nas
duas direções; recibos fora de ordem; eco/nota privada/histórico sem novo envio;
revogação durante I/O e antes do despacho; callback indisponível; dedupe/restart;
cursor expirado e recuperação de estado incerto.

Suíte sintética, coleção gerada ou presença do serviço no Compose não comprovam
entrega nem instalação. Sem acesso à versão CCLX/JRC alvo ou provider autorizado,
registrar o caso como bloqueado externo, com entrada faltante e roteiro pronto.
Não emitir credenciais ou enviar mensagem real para suprir essa evidência.
