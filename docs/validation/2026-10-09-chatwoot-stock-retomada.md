# Compatibilidade dos serializers e retomada — 09/10/2026

## Evidência do ambiente instalado

O operador concluiu o deploy da main `003aab1afd91ff80e01050c14a9781aae25a3681`, baseline `0050_whatsapp_group_catalog`. A inspeção autenticada confirmou caixa QR conectada, vínculo da automação de homologação na versão 2 e heartbeats recentes de mensagem, automação, IO e agendamento. Nenhuma caixa Meta estava configurada.

Na caixa exclusiva de testes, a atribuição automática da central foi desativada e a persistência da configuração foi conferida após recarregar. A nova mensagem solicitada ao operador chegou ao Broker e apareceu no histórico correspondente do JRC Conversas. Isso confirma o recebimento e o espelhamento dessa entrada, sem comprovar ainda resposta do bot ou transferência humana.

A tentativa autorizada de iniciar uma nova sessão permaneceu `ACTION_REQUIRED`, fase `PREPARED`, código `ATTENDANCE_RESUME_REMOTE_UNAVAILABLE`. O diagnóstico de leitura usando a credencial já persistida retornou caixa válida, mas `CHATWOOT_INVALID_RESPONSE` no robô e na conversa. A inspeção sanitizada seguinte mostrou HTTP 200 com objeto vazio no endpoint do robô; na conversa, IDs e `updated_at` numéricos, responsável humano presente e `meta.team` omitido. Nenhum conteúdo de cliente nem credencial foi incluído nesta evidência.

## Causa e contrato verificado

A UI da central identificou a versão v4.16.2, build `80f7305`. A fonte desse commit foi lida localmente, sem editar a central:

- `app/controllers/api/v1/accounts/inboxes_controller.rb`, ação `agent_bot`, lê o robô da caixa.
- `app/views/api/v1/accounts/inboxes/agent_bot.json.jbuilder` renderiza o partial somente quando há robô. O teste de controller exige resultado vazio quando ausente; o GET real comprovou `{}` no nível superior.
- `app/views/api/v1/accounts/conversations/show.json.jbuilder` usa `app/views/api/v1/conversations/partials/_conversation.json.jbuilder`. Esse partial emite responsável e tipo apenas quando há atribuição, time apenas quando presente, e `updated_at` como `conversation.updated_at.to_f`.
- O webhook usa outro produtor: `PushDataHelper` delega a `Conversations::EventDataPresenter`, cujo `push_meta` sempre inclui `assignee` e `team`, inclusive com `nil`. `WebhookListener`, `WebhookJob` e `Webhooks::Trigger` preservam essas chaves até a serialização JSON. O adaptador `JrcBroker::WebhookDelivery` não transforma o payload. Portanto, a omissão aceita no GET não foi estendida aos callbacks: responsável ausente no webhook continua `UNKNOWN`.

O Broker exigia `agent_bot: null` e `meta.assignee`/`meta.team` explicitamente nulos. Essas exigências rejeitavam respostas válidas da central antes de despachar qualquer alteração remota.

## Correção limitada

O cliente aceita o objeto superior exatamente vazio como ausência de robô, além do envelope explícito com `agent_bot: null` ou um robô válido. Um objeto não vazio sem `agent_bot`, arrays e dados de robô malformados continuam inválidos; envelopes válidos preservam o comportamento anterior de ignorar campos adicionais. A conversa normaliza somente as omissões documentadas de responsável/time para `null`; mantém IDs, status, identidade de responsável e o timestamp factual, inclusive sua parte fracionária.

Nenhum timestamp é inferido de `last_activity_at`, `timestamp` ou do relógio local. A retomada continua exigindo sua leitura factual, as três mutações separadas, leitura de confirmação e revisões atuais. Controle humano concorrente, alteração de credencial/vínculo e resultado desconhecido continuam impedindo liberação indevida. Não houve atualização direta do banco produtivo nem reprocessamento de mensagens históricas.

## Verificação e limite do aceite

Os testes de regressão reproduziram três falhas de parser e uma retomada `ACTION_REQUIRED` em PostgreSQL antes da correção. Os cenários usam somente fixtures sintéticas do formato observado. Incluem preservação de robô concorrente, responsável humano, isolamento de conta/conversa, metadados malformados e timestamp ausente. A suíte de retomada confere escrita separada, leitura final e watermark persistido, junto com as corridas já existentes.

Verificação local concluída: 24 testes dos clientes de integração, 24 testes PostgreSQL de concorrência/retomada e a suíte completa de 297 arquivos com 2.341 testes passaram. O build, o contrato público, as atribuições de terceiros e a inspeção do bundle também passaram; o bundle não apresentou achados. A aprovação de CI da nova revisão e a publicação das imagens ainda precisam ser confirmadas separadamente. Nenhum desses resultados substitui o aceite da conversa real após o deploy.

O editor de produção validou a versão 2 de seis blocos/seis conexões. Esse fluxo possui menu e respostas de teste; ainda não inclui captura e transferência reais. A central mostrou zero regras de automação inteligente, interface de chamada inativa e ausência dos módulos delegados Flow/QR desenvolvidos em P9. Essas capacidades não foram declaradas homologadas.

A correção exige publicação de imagem da main e deploy pelo operador. O próximo aceite real é nova sessão → menu → escolha → captura → transferência humana → resposta do agente → retomada, com comparação entre aparelho, Broker e central. Os demais tenants JRC e instalação externa serão configurados para a matriz final. O programa P0–P10 permanece em execução.
