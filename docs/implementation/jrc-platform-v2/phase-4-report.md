# Fase 4 — Canais unificados e Meta

Data: 2026-09-21  
Branch: `codex/jrc-platform-v2-phase4-channels-meta-20260921`

## Resultado

A operação de canais passa a ter uma fachada canônica sem substituir os registros existentes. Instâncias QR, canais de mensageria, conexões Meta, destinos Chatwoot e Flows continuam como fontes especializadas; `/v1/channels` apenas compõe essa visão e delega mutações aos serviços existentes.

## Entregas

- Contrato `ChannelV1` com quatro estados independentes:
  - transporte;
  - provedor;
  - automação;
  - atendimento humano.
- Endpoints canônicos:
  - `GET /v1/channels`;
  - `POST /v1/channels`;
  - `GET /v1/channels/:id`;
  - `POST /v1/channels/:id/pair`;
  - `PUT /v1/channels/:id/destination`.
- Criação e pareamento QR delegados ao `InstanceService`, preservando idempotência e a identidade da instância.
- Início do Embedded Signup Meta delegado ao serviço já existente, com resposta `503` quando o aplicativo não está configurado.
- Vinculação do destino delegada ao serviço Chatwoot/JRC Conversas existente.
- Painel canônico em `/channels`, com criação em `/channels/new`, detalhe em `/channels/:id` e Meta em `/channels/meta/connect`.
- Assistente com as seis etapas: provedor, conta, canal, destino, automação e revisão. Somente provedor e etapa são mantidos em `sessionStorage`; tokens e desafios não são persistidos.
- Redirecionamentos das URLs públicas antigas `/providers`, `/conexoes`, `/conexoes/nova`, `/conexoes/:id` e `/whatsapp-oficial`.
- Normalização de eventos Meta para respostas `button` e `interactive`, contatos e localização.
- OpenAPI atualizado com os endpoints e esquemas canônicos.

## Segurança e isolamento

- Todas as leituras usam transação com contexto da organização e RLS.
- A organização vem da sessão autenticada; a API não aceita `organizationId` no corpo.
- Escritas revalidam o papel atual e recusam `VIEWER`.
- Pareamento exige `Idempotency-Key` e retorna `Cache-Control: no-store` e `Pragma: no-cache`.
- QR Code e código de pareamento permanecem apenas em memória na interface.
- Erros públicos seguem `application/problem+json` sem detalhes de banco ou provedor.

## Compatibilidade

As telas antigas continuam acessíveis apenas por rotas internas `/legacy/*` para testes de regressão. A navegação e as URLs públicas usam exclusivamente `/channels`.

## Banco de dados

Nenhuma migração nova foi necessária. A fase usa as tabelas das migrações `0012_meta_saas_onboarding`, `0013_generic_messaging`, `0014_chatwoot_integration`, `0024_flows` e `0025_flow_chatwoot`.

## Validação

- `npm run typecheck`: aprovado.
- Testes focados da API e Meta: 3 arquivos, 8 testes aprovados.
- Testes focados da interface: 7 arquivos, 61 testes aprovados.
- Build de produção: aprovado.
- Geração OpenAPI: aprovada; quatro caminhos canônicos presentes.
- `npm run security:contracts`: aprovado.
- `git diff --check`: aprovado.
- Suíte completa: 163 arquivos e 1.136 testes aprovados.

## Limites desta fase

- O cadastro real do aplicativo Meta ainda depende dos valores operacionais no Dokploy e da homologação na Meta.
- Esta fase não adiciona execução arbitrária de workflows n8n nem editor Typebot incorporado; esses itens pertencem às fases de automação seguintes.
- Não houve deploy, uso de credenciais reais ou alteração no servidor de produção.
