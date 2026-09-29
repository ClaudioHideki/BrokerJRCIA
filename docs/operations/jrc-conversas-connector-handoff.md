# Handoff: módulo de conexões no JRC Conversas e Chatwoot externo

Revisão do Broker: branch `codex/broker-product-completion-20260929`, base `a060fc182bbc10f0acf399e5a9dc537aaa63dceb`. O commit final e os digests devem ser preenchidos no manifesto da release. Este documento é contrato de integração e aceite para a máquina responsável pelo JRC Conversas. Nenhum código, branch ou imagem da central foi promovido nesta entrega.

## Produtos e propriedade dos dados

- Empresa no Broker: fronteira de isolamento, permissões e limites.
- Destino: instalação HTTPS JRC Conversas gerenciada ou Chatwoot externo aprovada pela JRC.
- Account: conta da empresa nessa instalação. Um número de Account é significativo somente junto da instalação/destino e sua revisão.
- Canal: WhatsApp QR ou Meta gerenciado pelo Broker.
- Inbox: caixa API na Account, com agentes e conversas na central.
- Vínculo: associação de canal a Inbox. `READY` representa configuração do vínculo; não comprova entrega.

Não ativar a ponte direta Evolution → Chatwoot na mesma conexão que usa Broker → Chatwoot. O Broker deve ser o único responsável por encaminhar mensagens. Notas privadas da central não são mensagens ao WhatsApp.

## Jornada no Broker entregue

1. Escolher instalação, aprovar o endereço externo e vincular Account/token.
2. Criar conexão QR/Meta ou selecionar existente.
3. Criar caixa API ou adotar uma já existente, confirmando substituição de webhook quando necessária.
4. Ler QR ou concluir autorização Meta, confirmar identidade observada quando exigida.
5. Enviar mensagem de teste, responder publicamente pela Inbox e conferir timestamps de webhook, entrada e saída.
6. Publicar Flow e vinculá-lo ao canal, opcionalmente.

O assistente QR utiliza operações persistentes já existentes no backend: cria/seleciona instância, ativa recebimento, vincula Inbox, atribui agentes e confere configuração. Recarga consulta as operações salvas. Estado `UNKNOWN` oferece reconciliação, sem repetir criação cegamente. `SUCCEEDED` do assistente não significa WhatsApp pareado nem teste de entrega concluído.

## Contrato para o BFF da central

O token de controle emitido pelo Broker deve ficar exclusivamente no servidor da central. O navegador autentica com a sessão da central; o BFF valida usuário, Account, Inbox e permissão a cada chamada. Não aceitar Account/Inbox enviada pelo navegador sem validar pertencimento no servidor. A revogação do usuário na central deve valer no próximo acesso.

Rotas existentes (prefixo `/v1/integrations/chatwoot`):

| Operação | Rota | Observação |
|---|---|---|
| Contexto autorizado | `GET /control/context` | Organização, Account, origem, revisão de destino e capacidades |
| Recursos permitidos | `GET /control/resources` | Providers, instâncias e vínculos visíveis ao principal |
| Retomar configuração | `GET /control/onboarding` | Somente configurações no contexto autorizado atual |
| Iniciar configuração QR | `POST /control/onboarding` | `Idempotency-Key`, fonte EXISTING/NEW, nome, inbox opcional, agentIds, consentimento de webhook |
| Consultar andamento | `GET /control/onboarding/:operationId` | Estado e etapa persistidos |
| Recuperar andamento | `POST /control/onboarding/:operationId/recover` | `Idempotency-Key`; RETRY em falha, RECONCILE em resultado incerto |
| Saúde por vínculo | `GET /control/connections/:integrationId/status` | Sessão, identidade, evidências e allowedActions |
| Parear | `POST /control/connections/:integrationId/pair` | Chave idempotente e QR/código efêmero; somente allowedActions |
| Consultar pareamento | `GET /control/connections/:integrationId/pair-operations/:operationId` | Não gerar outro QR para contornar resultado pendente |
| Desconectar | `POST /control/connections/:integrationId/disconnect` | Chave idempotente; preserva registro e histórico |
| Confirmar identidade | `POST /control/connections/:integrationId/confirm-identity` | `observedRevision` atual e consentimento do usuário |
| Definir agentes | `PUT /control/connections/:integrationId/agents` | Somente agentes autorizados naquela Account |

Escopos de controle: `chatwoot:read`, `chatwoot:manage`, `chatwoot:pair`, `chatwoot:disconnect`. O campo `X-JRC-External-Actor` é atribuição auditável, não substitui autenticação nem autorização. Confirme suporte no OpenAPI gerado do commit final antes de consumir qualquer rota. A emissão de credencial é feita pelo administrador no portal e fica vinculada à Account/revisão do destino.

Esses escopos não concedem edição ou publicação de Flow. A sessão curta para editor embutido e o pacote de interface para outras versões Chatwoot precisam de implementação/revisão própria; não reutilizar chave de pareamento para conceder esse acesso.

## Interface na central

- Acesso em Configurações → Caixas → Conexão WhatsApp, sem depender de criar conversa artificial.
- Exibir situação da sessão, número mascarado, identidade e próximo passo. Mostrar QR somente enquanto válido; limpar em expiração, troca de Account/Inbox, logout e perda de permissão.
- `READY` = vínculo configurado. `CONNECTED` = sessão conectada. “Entrega verificada” exige transporte OPERATIONAL, identidade aprovada, webhook e timestamps de entrada/saída com sucesso.
- Botão de desconectar deve explicar que o pareamento precisará ser feito novamente. Excluir dados é ação separada e nunca deve ser inferida de desconectar.
- Exclusão no Broker preserva a Account e as conversas externas. Não chamar exclusão de Account implicitamente.
- Mostrar mensagens de falha por etapa, requestId para suporte e retomada de operação persistida.

## Aceite na outra máquina e homologação

Registrar versão/commit da central testada; a compatibilidade com todas as distribuições baseadas em Chatwoot não está comprovada.

1. Administrador da Account A controla apenas as suas Inboxes; negar ID de Account/Inbox de B.
2. Agente sem grant não recebe QR; revogar usuário/credencial bloqueia acesso imediatamente.
3. Fechar/reabrir ou recarregar recupera operação sem duplicar instância/Inbox.
4. QR expirado some; troca de número exige nova confirmação; resposta antiga não reaparece após revogação.
5. Entrada WhatsApp → Inbox e resposta pública → WhatsApp chegam uma vez; nota privada permanece interna.
6. Retry de webhook e reinício durante espera não duplicam resposta. UNKNOWN exige reconciliação.
7. Flow e executor legado não respondem ao mesmo evento; transferência humana bloqueia as respostas automáticas segundo a política da conversa.
8. Fazer os testes em uma instalação JRC e em uma instalação Chatwoot externa independente antes de anunciar ambas como suportadas.

As flags `CHATWOOT_CONTROL_ENABLED`, `CHATWOOT_EXTERNAL_DESTINATIONS_ENABLED` e `CHATWOOT_EMBED_ENABLED` controlam capacidades distintas. Emitir uma chave no Broker não instala o módulo na central. Cada repositório tem build, migrações, release e rollback próprios.
