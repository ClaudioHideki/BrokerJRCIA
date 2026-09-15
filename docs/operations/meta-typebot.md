# Meta e Typebot — primeiro incremento local

**Complemento SaaS:** a administração JRC, quotas/suspensão, portal e Embedded Signup foram acrescentados após esta matriz inicial. Para esses recursos, valem os guias [SaaS Meta](saas-meta.md), [administração](saas-admin.md), [isolamento/limites](saas-enforcement.md) e [Dokploy](dokploy-saas.md). As referências abaixo a cadastro manual e Signup pendente descrevem a primeira etapa e não substituem o fluxo SaaS atual.

Estado em 14/09/2026: percurso de mensagens de texto implementado e testável com serviços externos sintéticos. A plataforma completa do pedido ainda exige os itens pendentes abaixo. Nenhuma conta real foi conectada e nenhuma mensagem real foi enviada.

## Arquitetura e limites

O painel JRC usa contratos próprios e a autenticação existente. Evolution e Ligo são referências; o adapter Baileys foi preservado. O submódulo Evolution permanece no commit `fa09d37892cdbb1d65a250155d293d92230c5b30`.

O PostgreSQL mantém canais, contatos, conversas, mensagens, inbox, eventos de status, outbox e trabalhos de bot. Todas as oito tabelas usam RLS forçada e chaves compostas por organização. Este primeiro worker consulta a fila durável no PostgreSQL; RabbitMQ e armazenamento de mídia não foram introduzidos. Redis continua atendendo os controles de autenticação existentes.

Fluxo de saída: painel → API autenticada → mensagem e outbox na mesma transação → claim com lease → revalidação de política → HTTP Meta fora da transação → persistência do ID → webhooks de entrega/leitura. HTTP 202 da JRC significa aceitação na fila. Aceitação da Meta não comprova entrega. Timeout ambíguo permanece UNKNOWN, sem reenvio automático; exige reconciliação operacional antes de nova tentativa.

Fluxo de entrada: assinatura HMAC sobre bytes originais → associação de phone ID e WABA por configuração do servidor → contato/conversa e evento deduplicado → trabalho Typebot → sessão e respostas persistidas atomicamente → outbox Meta. O bot mantém um proprietário por conversa. A configuração de novo fluxo encerra os trabalhos pendentes do fluxo anterior e reinicia a sessão conforme contrato do repositório; atendimento humano impede respostas automáticas pendentes.

O formato inicial aceita texto, templates aprovados com variáveis posicionais BODY e cabeçalhos/rodapés textuais estáticos compatíveis com o dispatcher. Textos Markdown do Typebot são preservados como texto; tradução completa de formatação rica não foi implementada. Mídia, botões dinâmicos e blocos Typebot incompatíveis não são apresentados como suportados. Webhooks contendo formatos de entrada não suportados recebem erro e precisam de implementação posterior; não configurar tráfego geral de produção nesta fase.

## Tela, ação, endpoint e permissão

| Tela / ação | Endpoint | Permissão |
|---|---|---|
| Mensagens: canais | GET /v1/messaging/channels | JWT da organização |
| Templates do canal | GET /v1/messaging/channels/:id/templates | JWT da organização |
| Conversas do canal | GET /v1/messaging/channels/:id/conversations | JWT da organização |
| Histórico | GET /v1/messaging/conversations/:id/messages | JWT da organização |
| Enviar template | POST /v1/messaging/channels/:id/messages | OWNER, ADMIN, OPERATOR |
| Configurar Typebot | PATCH /v1/messaging/channels/:id/automation | OWNER, ADMIN |
| Assumir / retomar bot | PATCH /v1/messaging/conversations/:id/mode | OWNER, ADMIN, OPERATOR |
| Verificar webhook | GET /v1/webhooks/meta | Verify token do servidor |
| Receber webhook | POST /v1/webhooks/meta | Assinatura Meta válida |

API keys antigas de instâncias não recebem acesso implícito às novas rotas. A organização deriva do JWT, não de um campo livre no navegador. As rotas de mensageria consultam a membership atual e os estados de usuário/organização no servidor; o papel antigo do JWT não conserva acesso após rebaixamento ou remoção. O histórico é limitado às 100 mensagens mais recentes, apresentadas em ordem cronológica de persistência; paginação histórica é uma pendência.

## Executar localmente

1. Use a versão Node exigida em `package.json` (24.19.0), instale com `npm ci` e execute `npm run build`. O ambiente desta execução tinha Node 24.16.0: o desvio está registrado, sem alterar silenciosamente o requisito.
2. Siga `web-console.md` para PostgreSQL, Redis, migrações, bootstrap, autenticação e configuração da console. Use contas próprias de teste e segredos novos. A aplicação não carrega `.env` implicitamente; injete as variáveis no processo ou use a opção `--env-file` do Node.
3. Cadastre um canal Meta de teste já provisionado pelo operador usando `npm run messaging:channel:create`; ele não executa Embedded Signup nem certifica disponibilidade dos ativos.
4. Configure as variáveis abaixo no servidor. Não use variáveis `VITE_*` para credenciais. Os exemplos contêm placeholders, não credenciais utilizáveis.
5. Inicie API (`npm start`), frontend (`npm --workspace @jrc/web run dev -- --host 127.0.0.1`) e worker (`npm run start:messaging-worker -- --watch`). Garanta correspondência entre a origem do navegador e `CONSOLE_ALLOWED_ORIGINS`.
6. A URL de desenvolvimento é `http://127.0.0.1:5173/mensagens`, quando os processos estiverem iniciados. Nenhum servidor permanente é mantido pela execução dos testes.

```text
META_CREDENTIALS_JSON={"meta_cliente":{"accessToken":"SUBSTITUIR_NO_SERVIDOR","graphVersion":"vXX.X","organizationIds":["UUID_DA_ORGANIZACAO"]}}
META_APP_SECRET=SUBSTITUIR_NO_SERVIDOR
META_WEBHOOK_VERIFY_TOKEN=SUBSTITUIR_NO_SERVIDOR
META_ASSET_BINDINGS_JSON={"PHONE_NUMBER_ID":{"organizationId":"UUID_ORGANIZACAO","channelId":"UUID_CANAL"}}
TYPEBOT_ORIGINS_JSON={"typebot_cliente":{"origin":"https://SEU-VIEWER-TYPEBOT","accessToken":"SUBSTITUIR_SE_NECESSARIO","organizationIds":["UUID_ORGANIZACAO"]}}
MESSAGING_WORKER_ORGANIZATIONS=UUID_ORGANIZACAO
```

O cadastro exige uma conta `provider_accounts` existente, do tipo `META`, na mesma organização. O `credentialReference` da conta precisa coincidir exatamente com o campo enviado ao comando e com uma chave de `META_CREDENTIALS_JSON`; o comando não cria nem sobrescreve a conta de provider. Use uma conexão direta `jrc_app` e forneça somente IDs de ativos já obtidos por um operador autorizado:

```powershell
$env:DATABASE_URL='postgresql://jrc_app:SENHA@127.0.0.1:5432/jrc_broker'
$env:MESSAGING_CHANNEL_JSON='{"organizationId":"UUID_ORGANIZACAO","providerAccountId":"UUID_PROVIDER_ACCOUNT","phoneNumberId":"PHONE_NUMBER_ID","wabaId":"WABA_ID","credentialReference":"meta_cliente"}'
npm run messaging:channel:create
```

`MESSAGING_CHANNEL_JSON` é um objeto estrito: não aceita token, URL nem organização adicional. `organizationId` e `providerAccountId` são UUIDs; `phoneNumberId` e `wabaId` são identificadores numéricos; `credentialReference` aceita de 1 a 64 letras, números, `_` ou `-`. Em sucesso, o comando imprime apenas o UUID do canal criado. Use esse UUID em `META_ASSET_BINDINGS_JSON`. O cadastro confirma as relações locais e a separação tenant no PostgreSQL, mas não consulta a Meta e não comprova propriedade, disponibilidade ou homologação dos ativos.

Escolha uma versão Graph suportada, confirmada no painel/documentação Meta. O exemplo `vXX.X` é propositalmente inválido. A referência Meta deve coincidir com a conta de provider e com o canal cadastrados. A origem Typebot deve ser a origem do runtime/viewer HTTPS, sem caminho. O conector valida DNS e fixa a conexão em IP público; rejeita redes privadas, respostas de DNS mistas, redirects e respostas grandes. Não conecta a runtimes HTTP/localhost por padrão.

O worker executa um ciclo por padrão; `--watch` habilita consulta contínua. Somente organizações explicitamente configuradas são processadas. Usa conexão direta `jrc_app`, nunca a administrativa. Encerrar com SIGINT/SIGTERM aguarda o trabalho em curso; o lease permite tratar interrupção abrupta sem repetir cegamente HTTP incerto.

## Percurso automatizado reproduzível

Use PostgreSQL 16.4 e Redis 7.4 exclusivos de testes, publicados apenas em loopback. Os helpers criam bancos com nomes únicos e removem somente seus bancos/chaves. O papel `jrc_app` conecta diretamente; a configuração trust usada pelos testes deve ficar restrita ao container temporário local.

```powershell
$env:TEST_DATABASE_ADMIN_URL='postgresql://postgres@127.0.0.1:PORTA_POSTGRES/jrc_broker'
$env:TEST_REDIS_URL='redis://127.0.0.1:PORTA_REDIS'
npm run test:integration
npx playwright install chromium
npm run test:e2e
```

O teste `apps/web/tests/e2e/messaging.spec.ts` percorre login → organização → canal sintético previamente cadastrado → template com variável → entrega → webhook assinado → resposta do Typebot → atendimento humano, em desktop e mobile. Banco, autenticação, API e worker são reais. Meta e Typebot são doubles de teste; não há homologação externa, aprovação de template, campanha ou onboarding real nesse teste. Os fixtures não entram no runtime produtivo.

## Matriz de recursos

| Recurso | Situação deste incremento |
|---|---|
| Login, organizações, API keys e console Baileys | Restaurados do ZIP e integrados à base Git; correção da intenção de conexão após estado terminal |
| Meta texto/template e assinatura | Implementados; transporte coberto por doubles |
| Filas, consentimento básico, supressão e janela de atendimento | Repositório e revalidação implementados; operação de consentimento ainda sem módulo completo de UI |
| Conversas e atendimento humano | Listagem, histórico e troca BOT/HUMAN implementados |
| Typebot por API | Início, continuação, expiração, isolamento, configuração de fluxo e erros implementados |
| Embedded Signup / Coexistence | Não implementados nem homologados neste incremento |
| Cadastro/importação CSV/listas e evidência completa de consentimento | Pendentes |
| Criação/aprovação de templates e mídia | Pendentes; listagem/envio suportado já existem |
| Campanhas, agendamento/fuso, cancelamento e relatórios | Pendentes; não confundir envio individual com campanha |
| Webhooks de saída JRC | Pendentes; webhook de entrada Meta implementado |
| Editor Typebot dentro do SaaS | Não incorporado; decisão de licença separada |
| Dashboard consolidado, CRM e ferramentas de IA privilegiadas | Pendentes; nenhum workflow produtivo alterado |

## Meta: preparação externa

A documentação oficial de Embedded Signup retornou HTTP 429 nesta execução. Portanto não foi possível confirmar aqui a versão vigente ou sua data de descontinuação. O código não incorpora uma versão de Signup por suposição. Antes de implementar/publicar, confirmar a versão e parâmetros oficiais, vínculo criptográfico entre sessão e organização, origem do SDK, troca de código no backend, ativos autorizados, registro e assinatura, reconciliação e estados persistentes.

Separar as evidências: verificação empresarial da JRC; App Review e acesso avançado para cada permissão necessária; Access Verification de Tech Provider; domínio/HTTPS/redirects; política de privacidade e exclusão de dados; propriedade dos ativos de cada cliente; pagamento e pendências de cadastro. As permissões centrais da Cloud API são `whatsapp_business_management` e `whatsapp_business_messaging`; não ampliar para `business_management` sem necessidade comprovada. Referência oficial: [coleção Meta no Postman](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api).

Responsáveis pela homologação: operador JRC e titular dos ativos Meta/Typebot. Preparar gravação real do onboarding, envio aprovado, recebimento e tratamento de exclusão, além de credenciais/receptor de teste autorizados. As evidências locais não substituem avaliação/aprovação da Meta. Não foram submetidos pedidos de revisão nem alteradas contas produtivas.

## Typebot: edição e licenciamento

Neste incremento o cliente edita/publica em sua própria conta ou instância legitimamente utilizada e vincula o fluxo publicado ao canal JRC. Não foi copiado código do editor/runtime Typebot. Blocos de IA permanecem no fluxo do cliente; texto do bot não autoriza operações administrativas da JRC.

Alternativas futuras: conector com edição externa (adotado); versão específica cuja conversão para Apache 2.0 seja comprovada por data e versão; editor/runtime próprios; autorização comercial específica. A licença consultada é FSL-1.1-Apache-2.0, com conversão por versão após dois anos. Isso não prova que a versão atual inteira seja Apache. A documentação do Typebot restringe comercialização de acesso ao self-hosted e incorporação do editor em software vendido. Iframe ou subdomínio não substituem validação de licença.

Fontes consultadas em 14/09/2026: [licença](https://raw.githubusercontent.com/baptisteArno/typebot.io/main/LICENSE), [self-hosting](https://docs.typebot.com/self-hosting/get-started), [aplicações externas](https://docs.typebot.com/guides/external-messaging-apps), [start-chat](https://docs.typebot.com/api-reference/chat/start-chat), [continue-chat](https://docs.typebot.com/api-reference/chat/continue-chat).

## Riscos e próximos incrementos

Não publicar como plataforma completa. Além dos módulos pendentes, concluir provisionamento verificado Meta, gestão/rotação de segredos operacional, retenção/exclusão de dados, mídia segura, métricas e painel de reconciliação UNKNOWN. O painel humano permite pausar o bot e enviar templates; compositor de texto livre do atendente e encaminhamento para outro sistema ainda são pendentes. Falhas recuperáveis de consulta de template ficam aguardando recuperação operacional explícita; o worker não faz retry cego. A pausa humana cancela respostas automáticas ainda não iniciadas, mas uma chamada Typebot/Meta já iniciada pode terminar após a pausa; não prometer cancelamento de efeitos externos já disparados. Limites, preços e elegibilidade dependem da Meta; não há promessa de disparo ilimitado ou ausência de cobrança/bloqueios.
