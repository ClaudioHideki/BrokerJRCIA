# Meta SaaS da JRC

O aplicativo Meta pertence à JRC. O cliente autoriza seus próprios ativos pelo Embedded Signup. Nenhum aplicativo é criado para o cliente e a propriedade da empresa, WABA e número permanece com ele.

## Configuração de homologação externa

Somente servidor: `META_APP_ID`, `META_APP_SECRET`, `META_SIGNUP_CONFIG_ID`, `META_GRAPH_VERSION`, `META_TOKEN_ENCRYPTION_KEY` (32 bytes aleatórios, base64), `META_WEBHOOK_VERIFY_TOKEN`. A chave de cifragem deve ser persistida no gerenciador de segredos e recuperável com os backups; sua substituição sem recifrar impede usar os tokens anteriores. O navegador recebe somente app/config/version e estado efêmero. Nunca registrar código, PIN, token ou corpo Graph em logs.

A JRC precisa configurar Facebook Login for Business/Embedded Signup, domínios HTTPS autorizados, revisão e permissões aplicáveis no próprio app e assinatura de webhooks. A assinatura de mensagens existente valida HMAC sobre os bytes originais antes de encaminhar qualquer evento. Não houve chamadas Meta reais ou envio de mensagens nesta implementação local.

## Contrato HTTP

Todos os endpoints abaixo exigem JWT e membership atual OWNER/ADMIN. API keys legadas não autorizam onboarding. Organização vem da identidade, nunca do corpo.

- `GET /v1/meta-onboarding`: `{configured,connections}`.
- `POST /v1/meta-onboarding/start {}`: `{state,expiresAt,appId,configId,graphVersion}`. Estado aleatório dura dez minutos, armazenado somente como SHA-256, vinculado à organização/usuário; nova tentativa invalida a anterior desse usuário.
- FB.login usa `config_id`, `response_type:'code'`, `override_default_response_type:true`, `extras:{setup:{},sessionInfoVersion:'3'}`. A UI valida origem Facebook antes de interpretar sessionInfo.
- `POST /v1/meta-onboarding/complete {state,code,wabaId,phoneNumberId}`: conexão. O servidor consome estado antes da troca; erros não permitem replay. Valida app, validade/permissões/ativos no debug_token e número na lista Graph do WABA. SessionInfo nunca é autoridade. Persiste token AES-256-GCM com AAD organização/conexão e canal próprio. Reautorizar o mesmo número atualiza a conexão existente.
- `POST /v1/meta-onboarding/:id/register {pin}`: PIN de seis dígitos é encaminhado ao registro oficial e não armazenado; depois executa checagem de prontidão.
- `POST /v1/meta-onboarding/:id/refresh {}`: consulta status do número, review/funding/health do WABA e assinatura de webhooks. READY somente com CONNECTED, APPROVED, funding presente, health AVAILABLE e assinatura confirmada. Ausência de evidência mantém PENDING; a UI não oferece aprovação ou pagamento fictício.
- `POST /v1/meta-onboarding/:id/revoke {}`: apaga o token local, bloqueia envios e preserva histórico/ativos. O cliente também pode remover a autorização em Business Integrations/WhatsApp Manager. A resposta informa essa etapa externa; não afirma revogação remota realizada.

Conexão pública: `{id,channelId,wabaId,phoneNumberId,status,pending}`. As pendências são códigos canônicos como PHONE_REGISTRATION_REQUIRED, META_PAYMENT_METHOD_REQUIRED, META_BUSINESS_REVIEW_REQUIRED, META_ACCOUNT_HEALTH_REVIEW_REQUIRED e WEBHOOK_SUBSCRIPTION_REQUIRED. READY é prontidão observada, não comprovação de saldo, cobrança quitada nem garantia de aceitação futura pela Meta. Funding indica configuração; problemas posteriores continuam sujeitos às respostas oficiais de envio.

## Isolamento e revogação

Migration 0012 aplica RLS forçada a estados/conexões. Phone ID tem vínculo global único; funções de resolução de webhook expõem somente identificadores de roteamento. Tokens são lidos apenas em transações tenant e somente para conexão READY, não expirada e correspondente ao canal/WABA/número. Referências `meta-db:` nunca caem no registro estático. O provider account META é compartilhado dentro da organização, enquanto canais preservam tokens e ativos individuais.

Eventos assinados account_update/account_review_update suspendem a elegibilidade e reconsultam Graph. Erro OAuth 190 apaga token e marca REVOKED; indisponibilidade mantém pendência bloqueante. Eventos de mensagem continuam sendo armazenados inclusive após revogação, preservando o histórico. Atualização de estado não restaura uma conexão revogada por corrida com refresh. API e worker precisam usar o resolver dinâmico, e a validação final antes do POST reconsulta a elegibilidade da conexão.

## Evidências locais

Unitários/HTTP focados: seis testes passaram (cifragem/AAD, app incorreto, ativo incorreto, billing ausente, replay sem Graph, membership/API key/tenant injection). Integração PostgreSQL isolada cobre duas organizações, estado expirado/outro usuário/replay/concorrência, cifragem, prontidão e revogação. A descoberta de unicidade de provider por organização foi corrigida reutilizando provider account para múltiplos números. Comandos: `npx vitest run apps/api/tests/unit/meta-onboarding.test.ts apps/api/tests/unit/meta-onboarding-service.test.ts apps/api/tests/http/meta-onboarding.test.ts`; `npx vitest run --config vitest.integration.config.ts apps/api/tests/integration/meta-onboarding.test.ts` com TEST_DATABASE_ADMIN_URL local; `npx tsc -b --pretty false`.

## Fontes primárias verificadas

- [Coleção Embedded Signup oficial da Meta](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup): WABA, webhook, registro e etapas financeiras.
- [SDK oficial WhatsAppBusinessAccount](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/whatsappbusinessaccount.py): account_review_status, primary_funding_id, health_status.
- [OpenAPI oficial Meta](https://github.com/facebook/openapi/blob/main/business-messaging-api_v23.0.yaml): campos/estados de número e APIs WhatsApp.

O site developers.facebook.com retornou 429/indisponibilidade durante a consulta. As fontes oficiais alternativas acima foram consultadas. Homologação real do app, permissões, PIN, billing, review e entrega depende dos ativos e configuração externos da JRC e do cliente; não foi simulada como concluída.
