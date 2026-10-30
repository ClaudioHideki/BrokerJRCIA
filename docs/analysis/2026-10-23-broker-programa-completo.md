# Broker JRC: inventário e programa de capacidades

Data: 23/10/2026. Pedido: completar o Broker como produto independente para
Grupo JRC, CCLX e outras empresas, preservando a interface e os contratos JRC.
Este documento registra lacunas e critérios de aceite; não declara os lotes
futuros implementados nem substitui o desenho específico de cada lote.

## Base da auditoria

- Broker: base `be1e9441146d3ce8f9bc29b2f1b2fd135daf4371` e candidata local.
- Evolution fixada: `fa09d37892cdbb1d65a250155d293d92230c5b30`, versão 2.3.7.
- JRC: candidata consolidada `ab997ac5335992020181217a2dc66efffdbfd27c`,
  incluindo a revisão publicada `202c84cc` e a correção SIP `1f00e13c`.
  O frontend da candidata anterior `05c0a5e8` passou 580 arquivos e 5.703 testes.
  Rails terminou 1.055 exemplos sem falhas, mas 11 testes concorrentes ficaram
  pendentes; `ab997ac5` habilita o perfil descartável já aprovado e exige novo
  CI completo com zero pendências. A execução seguinte revelou resíduos dos
  testes concorrentes nos testes transacionais; a correção do CI está sendo
  preparada com bancos efêmeros separados, conforme o workflow Service Desk
  existente. Não é evidência de publicação da candidata.
- Inspeção REA parcial, leitura dos adaptadores e matriz de contratos:
  [paridade operacional](2026-10-23-evolution-paridade-operacional.md) e
  [API por família](2026-10-23-evolution-api-contract-matrix.md).
- Gate local Broker final após correções de logout, justiça da fila e contratos
  documentais: 442 arquivos e 3.395 testes aprovados, exit 0, em 1.000,24 segundos.
  Regressões PostgreSQL focais e adjacentes também passaram; respostas dos
  provedores nesses testes são sintéticas. Testes locais não provam entrega externa.
- Leitura do servidor em 23/10/2026 às 15:49 UTC: Broker `READY`, schema 0072
  compatível e PostgreSQL 16.4; 13 containers em execução. JRC publicado confirmou
  `202c84cc`. As abas Backups e Volume Backups do Broker não apresentam rotinas
  configuradas; isso não exclui cópias externas, mas elas ainda não foram verificadas.
  A migração 0073 da candidata requer backup conferido antes da atualização.

## Arquitetura a manter

`CCLX/JRC/outro consumidor -> API Broker -> domínio/outbox -> adaptador QR ou
Meta -> provedor`. A entrada percorre webhook, normalização, inbox durável,
conversa/evento canônico e consumidor. Flow usa o mesmo domínio e transporte.

Evolution continua motor privado do QR. A aplicação WhatsApp Business pode
parear por QR; isso não a transforma em Cloud API oficial. Os recursos da Meta
devem ter capacidades próprias por WABA, número, permissões e versão Graph.
Não abrir um passthrough com a chave global do motor para os clientes.

### Desenvolvimento próprio do motor

É possível manter um fork JRC da Evolution. Hoje este repositório tem um
submódulo apontado ao upstream oficial, fixado no commit auditado; o workflow
de imagens publica API e web do Broker, não uma nova imagem de motor customizado.
O fork ainda exige uma entrega específica:

1. Criar a derivação mantendo origem, licença e atribuições; registrar a base e
   o pequeno conjunto de patches JRC. Não editar o submódulo preservado de modo
   não rastreável nem contornar suas verificações de integridade.
2. Acrescentar no motor somente mudanças de transporte, sessão, protocolo e
   recursos WhatsApp realmente ausentes. Regras de tenant, campanhas, Flow,
   interface e contrato do cliente continuam no domínio Broker.
3. Definir testes de compatibilidade do adaptador, webhooks, identidade, mídia,
   reconexão, logout e persistência contra o fork; validar também o motor base.
4. Criar CI e build da imagem do motor por SHA/digest, SBOM/provenance e catálogo
   de compatibilidade com o Broker. Acrescentar um processo explícito de revisar
   e incorporar correções futuras do upstream e Baileys.
5. Publicar e homologar a imagem em instância de teste; atualizar somente
   EVOLUTION_ENGINE_IMAGE no Compose após o aceite, preservando bancos/sessões,
   migrações próprias e digest anterior para reversão.

O fork não cria capacidades que o protocolo QR não oferece, nem altera as
permissões da Cloud API Meta. Correções no motor e no adaptador devem ter recibos
e evidência real, especialmente PTT, grupos, LID e qualquer implementação de voz.

Uma organização do Broker isola seus usuários, credenciais, instâncias,
canais, arquivos, conversas, eventos e automações. Casa do Construtor/CCLX recebe
sua organização e chave própria. No Grupo JRC, a Account compartilhada com
três caixas permite cadastro comum, Suporte/Financeiro comuns e três times
comerciais. Agentes podem participar de várias caixas/times; a atribuição e
a visibilidade devem ser verificadas no host, não inferidas pelo nome da caixa.

## Inventário e entregas necessárias

| Frente | Base encontrada | Entrega restante e aceite |
| --- | --- | --- |
| Conexões | Criar, parear QR/código, consultar, desconectar; operações idempotentes | Homologar criar/conectar/perder sessão/reconectar/excluir/recriar sem duplicatas. Finalizar fence de logout e justiça entre matrículas novas. |
| Vínculo automático | Intenção autenticada de matrícula inicial na candidata; descoberta de caixas no JRC | Nova conexão autorizada e identidade confirmada entram no atendimento sem segundo cadastro manual. Troca de número/legado não são aprovados por GET. Revogação/suspensão/logout vencem operações concorrentes. |
| Atendimento individual | Texto canônico, projeção/resposta Chatwoot e estado de mensagem | Comprovar entrada e saída pelo celular, Broker e host; separar mensagem enviada no celular de resposta do operador; quote/reply, recibos, sincronização e prevenção de loop. |
| Mídia externa | Adaptador de envio, anexos na ponte/Flow e download privado por parceiro | Criar upload privado e envio genérico por referência de arquivo; imagem, PDF/documento, vídeo, áudio e sticker. Validar cotas/MIME/tamanho, expiração, isolamento e revogação no despacho. |
| Voz e vídeo curtos | Áudio como arquivo e caminhos upstream distintos | Homologar nota de voz PTT e codec/conversão; PTV tem contrato próprio. Não apresentar arquivo de áudio como PTT sem prova. |
| Conteúdo especial | Menu textual Flow; upstream tem localização/contato/reação/lista/botões/enquete | Preservar representação canônica de envio e recebimento, referência/autor, resposta e versão. Não descartar silenciosamente conteúdo não suportado. |
| Identidade | IDs externos, telefone, contato/conversa/canal | Auditar LID, PN/JID, identificadores alternativos e BSUID/username. Não deduzir telefone nem unir clientes por heurística; responder pela identidade ativa correta. |
| Contatos e chats | Projeção e consultas de domínio; upstream oferece mais comandos | Completar catálogo paginado, busca, perfil, presença, leitura explícita, arquivo, bloqueio, edição e remoção de mensagem, respeitando capacidade do canal e histórico. |
| Grupos | Catálogo limitado, texto explícito e ingresso textual | Receber/enviar mídia de grupos; participantes/administradores, convites, nome/foto/descrição, permissões, temporárias e saída. Eventos de grupo e distinção entre autor e destinatário. |
| Histórico | Importação com checkpoints e opção syncFullHistory | Progresso e retomada duráveis, deduplicação, mídia, data original e limites. Histórico não dispara URA nem campanha; não prometer cópia completa do telefone. |
| Campanhas | Wizard/listas, seleção de público/remetente, ritmo, fila e intents JRC | Toda caixa reconhecida aparece com diagnóstico real; selecionar somente remetentes aptos. Testar texto+imagem/PDF, lista/entrada manual/contatos, deduplicação, pausa/retomada/cancelamento e falhas parciais. Campanha individual sequencial e lista nativa broadcast são modalidades diferentes. |
| Flow/URA | Editor, versões, publicação, simulação, bindings e executor JRC | Testar WhatsApp real, espera/timeout, mídia, HTTP/IA, retomada após reinício, transferência por time/agente e um executor por conversa. Retomada do bot explícita; pareamento não liga automação. |
| Distribuição humana | Catálogos e handoff; regras pertencem também ao host | Comprovar filtro por caixa/time, disponibilidade e menor carga; funcionário em três caixas atende as três sem duplicar atendimento. Definir comportamento sem agente disponível e fora do horário. |
| Chatwoot/JRC | Destino/Account/inbox, callback, controle e integração de campanha | Homologar caixa nova e existente, leitura/escrita/anexos, assinatura, loop, retomada, falha remota e reconciliação. Não reutilizar URL/Account de outra instalação. |
| CCLX | Chave de parceiro, módulo QR portátil e contratos separados de controle/Flow | Implementar os hooks do backend do host, cofre, sessão/CSRF/permissão e ponte local; homologar Chatwoot 3.x exato e estratégia de Pub/Sub. Módulo QR sozinho não instala mensageria ou Flow. |
| Meta | Webhook, assinatura, ativos, Embedded Signup e adaptador existentes | Homologar troca de code no backend, propriedade/isolamento WABA/número/token, assinatura, templates, mídia, qualidade/estado, revogação e renovação. Grupos/chamadas oficiais existem como APIs específicas; implementar só após confirmar elegibilidade e contrato da versão usada. |
| Eventos | Feed durável e webhook assinado; quatro famílias públicas | Ampliar schemas para grupos, conteúdo especial, edição/remoção/reação, contatos/chats/presença e chamadas conforme implementação. Definir ordem, deduplicação, retenção, cursor, tentativa e recuperação. |
| Outros transportes | Não há equivalência pública geral para todos os transportes Evolution | Acrescentar WebSocket e conector de fila realmente necessário a partir da outbox canônica. RabbitMQ/NATS/Kafka/SQS/Pusher não precisam ser todos instalados para a POC via webhook/feed. Cada conector exige isolamento, persistência, confirmação, retry e DLQ. |
| Proxy | Nenhum contrato JRC equivalente encontrado | Implementar configuração por instância com cofre, destino permitido, diagnóstico e reconexão controlada. Não usar proxy para mascarar conexão defeituosa. |
| Chamadas | Rejeição/mensagem configuráveis; offerCall QR fixado é stub | Projeto próprio para sinalização, áudio bidirecional, permissão, sessão, transferência e observabilidade. Validar transporte real QR/Meta separadamente antes de exibir botão de chamada. |
| Interface | Candidata tem seis áreas por conexão e exclusão nos cartões | Completar controles de capacidades reais, formulários, grupos/chats/mídia, erros acionáveis e estados de carregamento/vazio/expiração. Acessibilidade, responsividade, i18n e permissões iguais no backend. |
| Administração | Organizações, papéis, limites, indicadores e auditoria | Empresa administra seus recursos; plataforma administra provedores, capacidade, incidentes e suporte auditado. Diagnóstico por conexão sem revelar mensagens/chaves de outra empresa. |
| Documentação | 19 operações genéricas + 15 de controle Chatwoot; Flow separado | Mesma fonte para OpenAPI/Swagger, PDF e Postman. Descrever cada endpoint, escopo, IDs, exemplos, erro, limite, paginação, idempotência, recebimento e efeito. Coleções de escrita exigem opt-in e abortam de verdade em pré-condição inválida. |

As próximas implementações devem atualizar a matriz consultável de capacidades
por provedor/versão/tipo/direção, para a UI e o consumidor não oferecerem uma
ação que o servidor não executa. Sua rota e schema ainda precisam do desenho do
lote; não estão publicados pela presença desta recomendação.

## Consumo pelo CCLX e outras empresas

O percurso inicial recomendado continua sendo **CCLX consome API JRC**. Recebe
origem HTTPS e chave do seu tenant, mantida no backend do CCLX. Pode criar a
instância, obter QR, acompanhar estado e consumir as operações publicadas.
O frontend usa a sessão local ou delegação curta, sem chave global/tenant fixa.
Webhook exige um callback público do consumidor; sem callback, o feed com cursor
permite receber eventos. Não é necessário obter token Chatwoot para esse percurso.

Para criar caixas/projetar mensagens/atribuir na instalação Chatwoot, há duas
opções implementáveis: adaptador do próprio CCLX consumindo os eventos e APIs
locais, ou ponte direta Broker configurada com destino, Account e credencial
remota. Os dois caminhos não podem duplicar o mesmo envio ou dono da conversa.
Flow incorporado acrescenta sessão delegada, catálogo e recibos de comandos do
host. Versão e Pub/Sub exatos do CCLX continuam dependências externas de aceite.

## Servidor, banco e Compose

Manter `infra/dokploy/compose.yaml` como composição de produto. Atualmente declara
web, api, worker de mensageria, automation-worker, automation-io-worker,
partner-events-worker, scheduler-worker, history-import-worker, lifecycle-worker,
automation-sandbox, migrate, postgres, redis e evolution. `migrate` é pontual no
perfil maintenance; partner-events-worker depende do perfil partner-api.

- API e todos os workers usam a mesma `JRC_API_IMAGE`; web usa `JRC_WEB_IMAGE`
  do mesmo commit. Evolution usa `EVOLUTION_ENGINE_IMAGE` revisada e fixada.
  Rails/Sidekiq do JRC acompanham sua própria imagem. Não fundir sistemas e
  bancos independentes numa imagem única.
- Preservar banco, sessões do motor, Redis e arquivos; nunca executar atualização
  com `down --volumes`. Migrar com backup, conferir log/exit0/baseline/READY e
  só depois trocar processos. O código desta candidata acrescenta migration0073.
- Novas tabelas/colunas devem ter isolamento/RLS, índices de consulta/claim,
  integridade, retenção e cobertura do expurgo lifecycle. Expandir schema antes
  de consumidor incompatível, com rollback que não repita efeitos externos.
- Medir conexões/pools por processo, concorrência, filas, CPU/memória, disco,
  armazenamento de mídia, webhook egress e latência. Dimensionamento sem carga
  medida não comprova capacidade. Redis interno não é a API de eventos do cliente.
- Storage privado existente pode atender mídia; para S3 usar configuração e
  política de bucket corretas, credenciais mínimas e validação de acesso. Não
  adicionar MinIO/RabbitMQ/Kafka sem requisito operacional do lote correspondente.
- Conferir HTTPS/proxy, preservação do corpo bruto do webhook, limites de upload,
  timeouts, origins permitidos e encadeamento confiável de IP. Não publicar portas
  de banco/Redis/Evolution nem colocar tokens do motor no navegador.
- Instalar e medir backup cifrado fora do host, restauração/PITR quando exigido,
  recuperação de sessões e reconciliação SENDING/UNKNOWN. A stack única atual
  não demonstra alta disponibilidade ou RPO/RTO contratados.

Variáveis já previstas que devem ser conferidas, sem imprimir valores:

| Grupo | Chaves existentes |
| --- | --- |
| Publicação | JRC_API_IMAGE, JRC_WEB_IMAGE, EVOLUTION_ENGINE_IMAGE, PUBLIC_ORIGIN, BROKER_HOST, COMPOSE_PROFILES |
| Motor QR | EVOLUTION_API_KEY, QR_WEBHOOK_SIGNING_KEY; base interna Evolution no Compose |
| Chatwoot | CHATWOOT_EXTERNAL_DESTINATIONS_ENABLED, CHATWOOT_CONTROL_ENABLED, CHATWOOT_EMBED_ENABLED, CHATWOOT_BASE_URL, CHATWOOT_MEDIA_ORIGINS, INTEGRATION_ENCRYPTION_KEY |
| API de parceiro | API_KEY_HMAC_SECRET, PARTNER_WEBHOOK_ENCRYPTION_KEY, PARTNER_EVENTS_WORKER_INTERVAL_MS e pool do worker |
| Meta | META_APP_ID, META_APP_SECRET, META_SIGNUP_CONFIG_ID, META_GRAPH_VERSION, META_TOKEN_ENCRYPTION_KEY, META_WEBHOOK_VERIFY_TOKEN; mapeamentos de ativos/credenciais existentes |
| Flow | AUTOMATION_RUNTIME_V2_ENABLED, CREDENTIAL_VAULT_KEYS_JSON, AUTOMATION_SANDBOX_TOKEN e intervalos dos workers |
| Arquivos | MEDIA_STORAGE_DRIVER, MEDIA_STORAGE_BYTES_PER_ORGANIZATION e MEDIA_S3_* se esse driver for usado |

Configuração por empresa pertence ao banco/cofre autorizado, não a uma nova
variável global por cliente. Valor presente não comprova ativo/credencial válido.
Não regenerar chaves de criptografia no deploy: isso pode tornar dados ilegíveis.
Segredos antes expostos precisam rotação planejada e validação dos vínculos.

## GitHub, contratos e critérios de liberação

- Branches e revisões candidatas por lote; manter o código upstream fixado e suas
  licenças/atribuições. Não atualizar para latest nem promover RC sem homologação.
- CI por revisão: lint/typecheck/build, unitários, contratos, PostgreSQL/Redis/RLS,
  storage, workers e concorrência, compilados, interface/E2E e dependências.
- Gerar OpenAPI e artefatos; falhar com drift. Postman/Newman deve verificar JSON,
  estados, IDs e pré-condições no ambiente de teste, com segredos fora dos arquivos.
  Teste de gerador ou mock não equivale a uma execução contra WhatsApp real.
- Produzir API/web por SHA e digest, SBOM/provenance e documentação do mesmo SHA;
  imagem publicada no GHCR não significa implantação. Registrar digest anterior.
- Homologar dois tenants sintéticos, permissões diferentes, QR de teste e ativos
  Meta de teste: entrada/saída texto e mídia, grupo quando suportado, recibos,
  duplicação, webhook inválido, revogação, indisponibilidade, reconexão, reinício,
  resultado incerto, transferência humana e retomada. Não usar números atuais
  para migração/novo pareamento sem janela e escopo específicos.
- Conferir versão/migrações/saúde/filas no Dokploy e entregar evidência de ponta a
  ponta no consumidor. A POC CCLX deve acrescentar aceite de instalação e operação
  na versão do host. Capacidade/função indisponível deve aparecer honestamente.

## Ordem de execução

1. Fechar bugs atuais e release candidata: logout, isolamento de fila, vínculos,
   diagnóstico de remetentes, exclusão, seis áreas e documentação consistente.
2. Mídia pública e identidade/conteúdo canônicos, com capacidades explícitas.
3. Ponte/instalador CCLX e URA/handoff, com QR e Meta homologados por jornada.
4. Grupos completos, controles de conversa e tipos especiais por capacidade.
5. Transportes adicionais necessários, proxy e expansão Meta elegível.
6. Voz real, escala/alta disponibilidade e aceite operacional/comercial próprios.

Cada lote precisa de seu desenho pequeno, teste que reproduz a lacuna, entrega
vertical (domínio/adaptador/API/UI/documentação) e prova de aceite. Completar um
lote não declara os demais concluídos. O critério é a matriz acordada de recursos,
versões e jornadas; não a promessa de reproduzir qualquer recurso futuro do WhatsApp.

Demandas paralelas do JRC permanecem separadas: o NICO respondeu `NICO_OK` em
teste real nesta rodada, mas execução de tarefas ainda não foi comprovada; as
reservas de consumo incerto não foram apagadas. Os clientes BemTeVi não foram
importados: a consulta da origem retornouHTTP500 e não confirmou os ativos
atuais. O importador está testado, sem converter o snapshot antigo em prova de
atividade atual. O novo pareamento da caixa Gestor Thiago foi adiado pelo usuário.

## Modelo para executar o desenvolvimento

Recomendação para este programa: Astra com esforço alto nas decisões de
arquitetura, identidade/concorrência e revisão final; GPT-6.1 Sol com esforço alto
na implementação recorrente dos lotes já desenhados, testes e documentação.
Se for necessário escolher só um e a prioridade for qualidade para o escopo
completo e ambíguo, escolher Astra. Esta é uma recomendação de trabalho baseada
na orientação oficial, não um benchmark executado neste repositório. Pro é o
plano de acesso; modelo, esforço e velocidade são controles distintos.

Fontes oficiais consultadas em23/10/2026:
[modelos](https://learn.chatgpt.com/docs/models) e
[seleção](https://developers.openai.com/api/docs/guides/model-selection).

## Referências primárias atuais e sinais externos

- [Evolution RC1](https://github.com/evolution-foundation/evolution-api/releases/tag/2.4.0-rc1)
  e [RC2](https://github.com/evolution-foundation/evolution-api/releases/tag/2.4.0-rc2):
  candidatas com ativação/migração; não são autorização para upgrade cego.
- [Baileys migração v7](https://github.com/WhiskeySockets/baileys.wiki-site/blob/main/docs/migration/to-v7.0.0.md)
  e [histórico](https://raw.githubusercontent.com/WhiskeySockets/docs/main/advanced/history-sync.mdx).
- [OpenAPI oficial Meta v23](https://github.com/facebook/openapi/blob/main/business-messaging-api_v23.0.yaml):
  contém APIs específicas de grupos/chamadas; não prova suporte JRC ou elegibilidade.
  As páginas Meta detalhadas retornaram429 nesta pesquisa; a configuração Graph
  informada anteriormente pelo usuário era v25, sem nova leitura de ENV nesta auditoria.
- [Chatwoot BSUID](https://www.chatwoot.com/hc/user-guide/articles/1788437540-bsuid),
  [API inbox](https://www.chatwoot.com/hc/user-guide/articles/1677839703-how-to-create-an-api-channel-inbox)
  e [WebSocket](https://www.chatwoot.com/hc/user-guide/articles/1677691027-how-to-setup-a-web_socket-connection).
- [Evolution issue2755](https://github.com/evolution-foundation/evolution-api/issues/2755)
  e [relato Reddit](https://www.reddit.com/r/EvolutionAPI/comments/1lyoc9c/evolution_api_connected_but_no_chats_contacts_or/)
  são sinais para regressão, não reprodução no nosso ambiente. Relatos de blogs
  e comunidade não substituem o contrato oficial e a observação de entrega.
- [Artigo da Prospecta sobre Evolution/Chatwoot](https://www.prospectasuite.com.br/blog/evolution-api-chatwoot-integracao)
  ajudou a localizar cenários antigos de sincronização. As issues relacionadas
  [Evolution485](https://github.com/evolution-foundation/evolution-api/issues/485)
  e [Chatwoot8712](https://github.com/chatwoot/chatwoot/issues/8712) estão fechadas;
  não foram tomadas como defeitos atuais confirmados do Grupo JRC.
