# JRC WhatsApp Broker — Especificação de Arquitetura

**Status:** aprovado
**Data:** 03/09/2026
**Produto:** Broker SaaS multicliente JRC
**Base técnica:** Evolution API, com extensões e control plane próprios da JRC

## 1. Decisão arquitetural

O JRC WhatsApp Broker será um produto SaaS multicliente comercializado e operado pela JRC. A primeira versão utilizará a Evolution API como base técnica, sem aquisição de licença comercial, e respeitará integralmente as condições da licença, do arquivo `NOTICE` e da política de marcas vigentes na revisão adotada.

O produto terá identidade visual e painel próprios da JRC. O frontend protegido da Evolution não será apenas renomeado. Quando o backend Evolution ou código derivado for utilizado, haverá uma notificação administrativa clara e acessível informando esse uso. Arquivos modificados preservarão avisos de origem e registrarão as alterações.

Esta decisão busca acelerar a entrega sem criar a falsa premissa de que o código original da Evolution pertence à JRC. A arquitetura deverá permitir substituir gradualmente componentes derivados por implementações próprias sem alterar a API pública oferecida aos clientes.

## 2. Objetivo do produto

Entregar uma plataforma única para clientes da JRC conectarem números de WhatsApp por:

1. WhatsApp Cloud API oficial da Meta;
2. WhatsApp Business App ou conta compatível por sessão WhatsApp Web via Baileys;
3. Meta Coexistence, quando a conta e o recurso forem elegíveis;
4. WhatsApp Business Calling API, em uma trilha posterior e somente para conexões oficiais elegíveis.

O broker será responsável por conexão, normalização de eventos, mensageria, mídias, webhooks, segurança, auditoria e consumo. Regras conversacionais e inteligência continuarão em n8n, Typebot, Jade, Mocchi ou outros serviços integrados.

## 3. Posicionamento e limites

### 3.1 Responsabilidades do broker

- cadastrar organizações, tenants, usuários, aplicações e instâncias;
- conectar e monitorar provedores WhatsApp;
- enviar e receber mensagens e mídias;
- normalizar diferenças entre Meta e Baileys;
- publicar eventos para webhooks, filas e WebSocket;
- armazenar metadados, status, auditoria e consumo;
- proteger credenciais e sessões;
- aplicar quotas, rate limits e permissões;
- integrar JRC Conversas, n8n, Typebot e sistemas dos clientes;
- fornecer painel de administração e operação.

### 3.2 Fora do núcleo

- lógica completa de chatbot;
- CRM e gestão comercial;
- atendimento humano completo;
- automações específicas de cada cliente;
- motor de campanhas de marketing na primeira entrega;
- telefonia/SBC dentro do processo principal de mensageria.

Essas capacidades se conectam ao broker por APIs e eventos.

## 4. Modelo de licenciamento e marca

### 4.1 Obrigações da base Evolution

- preservar `LICENSE`, `NOTICE` e atribuições aplicáveis;
- indicar de forma clara que a plataforma utiliza Evolution API na área administrativa e na documentação;
- marcar arquivos derivados que tenham sido modificados;
- não remover nem substituir a marca do frontend Evolution protegido;
- não reutilizar nomes, logotipos, paleta ou identidade visual protegida da Evolution como identidade JRC;
- manter inventário de dependências e respectivas licenças;
- revisar novamente a licença antes de cada atualização de versão.

### 4.2 Estratégia de identidade JRC

O painel JRC será um frontend próprio que consome o control plane JRC. A Evolution será executada como engine interna ou fonte de componentes permitidos. O cliente verá a marca comercial JRC, enquanto administradores terão acesso às atribuições legais exigidas.

### 4.3 Regra de bloqueio

Nenhum componente será copiado, modificado, redistribuído ou ocultado antes de:

1. registrar origem, versão/commit e licença;
2. classificar o uso como dependência, fork, código adaptado ou referência;
3. confirmar as obrigações de atribuição e redistribuição;
4. adicionar os avisos necessários ao repositório e ao produto.

Esta especificação não substitui revisão jurídica antes do lançamento comercial.

## 5. Arquitetura lógica

### 5.1 Camadas

1. **JRC Control Plane:** organizações, tenants, usuários, planos, API keys, quotas, instâncias e configurações.
2. **JRC Broker Gateway:** API pública versionada, autenticação, autorização, rate limit, idempotência e roteamento.
3. **Broker Core:** modelo canônico de mensagens, comandos, eventos, status e capacidades.
4. **Provider Meta:** Cloud API, WABA, números, templates, webhooks, mídia, janela de atendimento e Coexistence.
5. **Provider Baileys:** QR/pairing code, sessão, reconexão, mensagens, mídias e eventos do WhatsApp Web.
6. **Event Hub:** RabbitMQ, workers, retries, DLQ, webhooks e WebSocket.
7. **Adapters:** JRC Conversas, n8n, Typebot e integrações de clientes.
8. **Data Plane:** PostgreSQL, Redis e MinIO/S3.
9. **Observabilidade:** métricas, logs, traces, alertas e auditoria.

### 5.2 Regra de isolamento

Toda entidade operacional será associada a `organization_id` e `tenant_id`. A identidade autenticada determinará o tenant; o backend não confiará em um `tenant_id` arbitrário enviado no corpo da requisição. Operações administrativas entre tenants serão permitidas apenas a papéis internos JRC explicitamente autorizados e auditados.

### 5.3 API estável e engines substituíveis

A API pública e os eventos canônicos da JRC não reproduzirão diretamente o contrato interno de uma versão específica da Evolution. Uma camada anticorrupção traduzirá comandos e eventos. Essa fronteira permite atualizar, substituir ou reimplementar a engine sem quebrar clientes.

## 6. Tipos de conexão

### 6.1 `META_CLOUD`

- conexão oficial;
- WABA e `phone_number_id`;
- tokens e permissões da Meta;
- templates e janela de atendimento;
- webhooks assinados;
- mensagens e mídias previstas pela versão adotada da Graph API;
- elegibilidade futura para Calling API.

### 6.2 `META_COEXISTENCE`

- modalidade oficial, quando disponibilizada e elegível;
- onboarding específico;
- capacidades registradas dinamicamente;
- não será confundida com sessão Baileys.

### 6.3 `BAILEYS`

- conexão não oficial baseada no WhatsApp Web;
- QR Code e pairing code;
- sessão/dispositivo e reconexão;
- capacidades sujeitas a mudanças do WhatsApp Web;
- sem promessa de Calling API oficial;
- aviso de risco e aceite contratual do cliente;
- monitoramento de desconexões, banimentos e incompatibilidades.

## 7. Modelo canônico

### 7.1 Envelope de comando

```json
{
  "command_id": "uuid",
  "idempotency_key": "string",
  "organization_id": "uuid",
  "tenant_id": "uuid",
  "instance_id": "uuid",
  "provider": "META_CLOUD",
  "type": "message.send",
  "payload": {},
  "correlation_id": "uuid",
  "occurred_at": "ISO-8601"
}
```

### 7.2 Envelope de evento

```json
{
  "event_id": "uuid",
  "schema_version": "1.0",
  "organization_id": "uuid",
  "tenant_id": "uuid",
  "instance_id": "uuid",
  "provider": "BAILEYS",
  "type": "message.received",
  "provider_event_id": "string",
  "payload": {},
  "correlation_id": "uuid",
  "occurred_at": "ISO-8601"
}
```

### 7.3 Capacidades

Cada instância publicará capacidades efetivas, como `text`, `image`, `document`, `audio`, `video`, `template`, `interactive`, `reaction`, `location`, `contact`, `group`, `presence` e `calling`. A API rejeitará antecipadamente recursos não suportados pelo provedor ou pela conta.

## 8. Modelo de dados mínimo

- `organization`: cliente contratante e dados comerciais mínimos;
- `tenant`: unidade lógica isolada;
- `user`, `role`, `membership`: acesso humano e RBAC;
- `application`, `api_key`: acesso serviço-a-serviço;
- `plan`, `subscription`, `quota`, `usage_record`: controle comercial;
- `instance`: conexão lógica do WhatsApp;
- `provider_connection`: tipo, identificadores externos, capacidades e estado;
- `credential`: referência de segredo criptografado e rotação;
- `device_session`: estado Baileys criptografado e vínculo com worker;
- `qr_session`: QR/pairing efêmero e expiração;
- `contact`, `conversation`, `conversation_map`: identidade e correlação externa;
- `message`: identificador interno, direção, tipo e estado atual;
- `message_provider_ref`: `wamid`, chave Baileys e demais referências;
- `message_status_event`: histórico imutável de status;
- `media_object`: metadados, checksum, storage key e retenção;
- `webhook_endpoint`, `webhook_subscription`, `webhook_delivery`: entrega ao cliente;
- `inbox_event`, `outbox_event`, `dead_letter`: confiabilidade;
- `audit_log`: trilha administrativa imutável;
- `usage_event`: consumo faturável e técnico.

Chaves únicas deverão impedir duplicação por tenant, instância, provedor e identificador externo.

## 9. API pública inicial

### 9.1 Organizações e acesso

- `POST /v1/organizations`
- `POST /v1/tenants`
- `POST /v1/api-keys`
- `GET /v1/usage`

### 9.2 Instâncias

- `POST /v1/instances`
- `GET /v1/instances`
- `GET /v1/instances/{id}`
- `POST /v1/instances/{id}/connect`
- `POST /v1/instances/{id}/disconnect`
- `DELETE /v1/instances/{id}`
- `GET /v1/instances/{id}/capabilities`
- `GET /v1/instances/{id}/qr`

### 9.3 Mensagens e mídias

- `POST /v1/instances/{id}/messages`
- `GET /v1/messages/{id}`
- `POST /v1/media`
- `GET /v1/media/{id}` com autorização e URL temporária;
- `GET /v1/instances/{id}/templates`
- `POST /v1/instances/{id}/templates/send`

Todas as operações mutáveis aceitarão `Idempotency-Key`. Respostas assíncronas retornarão `202 Accepted`, identificador interno e estado inicial.

### 9.4 Webhooks

- `POST /v1/webhook-endpoints`
- `POST /v1/webhook-endpoints/{id}/rotate-secret`
- `POST /v1/webhook-endpoints/{id}/test`
- `GET /v1/webhook-deliveries`
- `POST /v1/webhook-deliveries/{id}/retry`

Entregas terão assinatura HMAC, timestamp, prevenção de replay, tentativas com backoff e DLQ.

## 10. Fluxos essenciais

### 10.1 Entrada

1. Provider recebe evento Meta ou Baileys.
2. Assinatura/origem é validada quando aplicável.
3. Evento bruto recebe hash e é persistido no inbox.
4. O receptor responde rapidamente ao provedor.
5. Worker resolve tenant e instância.
6. Adapter converte para o evento canônico.
7. Mensagem, mídia e status são persistidos de forma idempotente.
8. Event Hub publica para destinos inscritos.
9. Entregas são registradas, repetidas ou encaminhadas à DLQ.

### 10.2 Saída

1. Cliente autenticado chama a API JRC.
2. Gateway valida tenant, permissão, quota e idempotência.
3. Broker valida capacidade e política do provedor.
4. Comando é persistido no outbox.
5. Worker envia pelo provider correspondente.
6. Referência externa é associada à mensagem interna.
7. Status posteriores atualizam o histórico monotonicamente.
8. Eventos são publicados aos consumidores.

### 10.3 Integração JRC Conversas

O adapter mapeará instância para inbox/conta/fila, contato para identidade externa e mensagem para conversa. Ele impedirá eco, preservará IDs, suportará mídia e propagará `correlation_id`. Falha no JRC Conversas não fará o webhook do provedor ser perdido.

## 11. Confiabilidade e erros

- inbox/outbox transacional;
- consumidores idempotentes;
- retry exponencial com jitter;
- DLQ com reprocessamento auditado;
- circuit breaker por provedor/destino;
- timeout explícito;
- estado de status monotônico e histórico imutável;
- quarentena para instância ou número desconhecido;
- isolamento de falhas por tenant e instância;
- reconexão Baileys com limite e classificação do motivo;
- backpressure e limites de concorrência;
- plano de rollback para Evolution/broker atual.

## 12. Segurança e LGPD

- TLS externo e interno onde aplicável;
- credenciais e sessões criptografadas com chaves fora do banco;
- rotação e revogação de API keys, tokens e segredos;
- RBAC e princípio do menor privilégio;
- assinatura de webhooks e proteção contra replay;
- mascaramento obrigatório de segredos e minimização de PII nos logs;
- URLs de mídia temporárias;
- retenção configurável de payload bruto, mensagens e mídias;
- exportação e exclusão por tenant;
- auditoria de acessos administrativos;
- segregação DEV/HML/PROD;
- varredura de dependências, imagens e segredos no CI;
- termos claros para o risco do conector Baileys.

## 13. Observabilidade e operação

Métricas mínimas:

- instâncias conectadas/desconectadas;
- mensagens por tenant, provider, tipo e estado;
- latência de entrada e saída;
- retries e tamanho de DLQ;
- falhas de autenticação e rate limit;
- consumo de filas;
- falhas de webhook por destino;
- reconexões Baileys;
- erros da Meta por código e versão;
- disponibilidade do broker.

Logs serão estruturados e pesquisáveis por `tenant_id`, `instance_id`, `message_id`, `provider_event_id` e `correlation_id`, sem registrar tokens ou conteúdo sensível por padrão.

## 14. Painel JRC

### 14.1 Operação JRC

- visão de organizações e tenants;
- planos, quotas e consumo;
- instâncias e saúde;
- erros, filas e DLQ;
- auditoria;
- impersonação controlada, temporária e auditada;
- ferramentas de diagnóstico sem exposição de segredo.

### 14.2 Portal do cliente

- usuários e permissões;
- criar e conectar instância;
- escolher Meta, Coexistence ou Baileys;
- acompanhar QR/status;
- gerenciar API keys e webhooks;
- consultar mensagens, eventos e consumo;
- consultar templates oficiais;
- visualizar alertas e documentação.

## 15. Calling API

Calling será um módulo posterior exclusivamente para conexões oficiais elegíveis. O desenho deverá cobrir permissões, sinalização, mídia, estados de chamada, consentimento, histórico, WebRTC/SIP quando aplicável e integração com SBC, Sytel e IMBridge. O broker de mensagens publicará eventos canônicos de chamada, mas não embutirá a lógica do contact center no provider Meta.

Baileys não receberá a mesma promessa comercial de Calling API.

## 16. Estratégia de código

### 16.1 Repositórios

Decisão aprovada por Welton/JRC em 03/09/2026: usar um único monorepo para control plane, gateway, contratos, painel, adapters e infraestrutura. A engine Evolution ficará isolada em `upstream/evolution-api` como submódulo Git fixado em commit imutável. O histórico continuará pertencendo ao upstream oficial, será obtido no checkout do submódulo e o repositório JRC não apagará autoria, licenças ou avisos.

### 16.2 Atualizações upstream

- fixar versão/commit homologado;
- nunca implantar `latest` em produção;
- acompanhar vulnerabilidades e releases;
- importar atualizações em branch específica;
- revisar diferenças de licença;
- executar regressão antes de promoção;
- manter rollback para a versão anterior.

### 16.3 Proibição de cópia cega

Funcionalidades da Evolution servirão como baseline, mas serão priorizadas pelo produto JRC. Recursos sem caso de uso, segurança adequada ou compatibilidade entre providers não serão copiados apenas para alcançar quantidade de endpoints.

## 17. Testes e critérios de aceite

### 17.1 Suite mínima comum

- texto e mídia inbound/outbound;
- idempotência de comando e evento;
- evento duplicado e fora de ordem;
- instância e tenant desconhecidos;
- isolamento tenant A/B;
- token inválido, expirado ou revogado;
- falha 4xx/5xx e timeout;
- retry e DLQ;
- indisponibilidade do JRC Conversas;
- webhook de cliente indisponível;
- segredo de webhook incorreto;
- quota excedida;
- mídia grande, inválida ou expirada;
- ausência de vazamento de segredo em logs.

### 17.2 Meta

- assinatura válida/inválida;
- janela de atendimento e template;
- status enviados fora de ordem;
- qualidade/limite do número;
- rotação de token;
- versionamento da Graph API.

### 17.3 Baileys

- QR expirado;
- pairing code;
- reinício de worker;
- reconexão;
- logout do dispositivo;
- conflito de sessão;
- atualização incompatível do WhatsApp Web;
- distribuição de instâncias entre workers.

### 17.4 Aceite do MVP comercial controlado

1. Dois tenants isolados conectam pelo menos uma instância cada.
2. Uma instância Meta e uma Baileys executam texto e mídia ponta a ponta.
3. JRC Conversas recebe e responde sem eco ou duplicação.
4. Webhook externo assinado recebe eventos e suporta retry.
5. Painel mostra conexão, erros, consumo e auditoria.
6. Backup/restore e rollback são testados.
7. Não há bug P0 nem vulnerabilidade crítica conhecida aberta.
8. Inventário de licenças e avisos está completo.

## 18. Fases de entrega

### Fase 0 — Auditoria e baseline

- selecionar versão/commit da Evolution;
- inventariar módulos, licenças e marcas;
- subir baseline isolado;
- executar smoke tests de Meta e Baileys;
- registrar funcionalidades aproveitáveis e lacunas.

### Fase 1 — Control plane e API JRC

- autenticação, tenants, instâncias, API keys;
- contratos canônicos;
- PostgreSQL, Redis, filas e MinIO;
- painel mínimo e observabilidade.

### Fase 2 — Baileys

- ciclo completo de instância e sessão;
- mensagens, mídias, status e reconexão;
- escala e recuperação de sessão.

### Fase 3 — Meta oficial

- Cloud API, webhook, WABA, números e templates;
- onboarding e Coexistence conforme elegibilidade;
- políticas e consumo.

### Fase 4 — Integrações

- JRC Conversas;
- n8n;
- Typebot;
- webhooks, RabbitMQ e WebSocket para clientes.

### Fase 5 — Comercialização

- planos, quotas, billing e portal;
- LGPD, termos, SLA e suporte;
- hardening, backup e recuperação;
- piloto assistido e go-live progressivo.

### Fase 6 — Calling

- validação da Meta;
- protótipo oficial;
- SBC/Sytel/IMBridge;
- operação de voz e observabilidade.

## 19. Cronograma de referência

Com dois desenvolvedores e ativos Meta já liberados:

- Fase 0: 3 a 5 dias úteis;
- núcleo e um provider em HML: 2 a 4 semanas;
- Meta + Baileys + JRC Conversas: 4 a 8 semanas;
- MVP comercial controlado: 8 a 12 semanas;
- paridade ampla priorizada com Evolution: 4 a 6 meses;
- Calling: trilha adicional dependente de elegibilidade e homologação externa.

Datas não incluem prazos de aprovação, verificação ou liberação da Meta.

## 20. Critério para iniciar implementação

A implementação começa após aprovação desta especificação. A primeira atividade será a Fase 0: criar o repositório, registrar licenças, fixar o upstream Evolution, executar o baseline e produzir a matriz de aproveitamento. Nenhuma alteração de produção ou migração de cliente ocorrerá nessa fase.
