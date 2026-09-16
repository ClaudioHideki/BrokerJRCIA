# Resultados de aceite — execução local

Referência: matriz original em `docs/reference/broker-chatwoot-20260916/docs/validation/`.
Branches: `codex/broker-chatwoot-control`, `codex/jrc-broker-native` e `codex/broker-chatwoot-embed`.
Commits Broker B1–B6: c47aed4, 998d54f, f1af2fb, b14aae9, 72baa75, 7424fbf.
B7: eeb3b38; complemento de descoberta 71be532.
J1–J5: 4f1a7cc, 1b26ea3, 7d316fe, 99df49d, 3dd2e48.
E1–E4: fe4ae32, 7847118, 6ad699e, 938e4b2. E5: commit de fechamento desta matriz.

Todos os resultados abaixo são do nível **local**, com PostgreSQL/Redis descartáveis,
identidades sintéticas e fixtures de providers. Níveis Chatwoot remoto e telefone
real: **BLOCKED**, dependem de piloto separado autorizado. Nenhum PASS local equivale
a teste remoto. NOT_RUN também cobre cenários ainda incompletos; a evidência parcial
é descrita sem promovê-la ao cenário completo.

Comandos executados e contagens estão em `2026-09-16-execution.md`; logs locais
sanitizados em `.sessions/b1-*` a `.sessions/b7-*` não são versionados.
Complementos: `2026-09-16-embed-execution.md`; no repositório JRC Conversas,
`docs/validation/2026-09-16-jrc-broker.md` e logs `.codex/j1-*` a `j5-*`.
Fechamento E5: 1.078 testes gerais, 222 de integração, dois compiled e oito browser
embed aprovados; navegador principal 11 PASS / 5 SKIP preexistentes. Relatório e
procedimento de homologação/rollback: `2026-09-16-delivery.md`.

| ID | Local | Evidência / pendência |
|---|---|---|
| A01 | PASS | qr-chatwoot-storage e chatwoot-tenants: transporte existente com flags de superfície desligadas |
| A02 | PASS | chatwoot-tenants: dois servidores HTTP locais, mesmos IDs, rotas/credenciais independentes |
| A03 | PASS | destinations/qr-chatwoot-storage: unicidade de origem/conta no PostgreSQL |
| A04 | PASS | destinations + HTTP plataforma: aprovação fora do papel tenant e nenhum token para destino pendente |
| A05 | PASS | safe-http/security: DNS, socket TLS fixado, IPv6, redirect e limites; sem chamadas reais |
| A06 | PASS | safe-http/tenants: headers de anexos capturados nas fixtures, sem token de API |
| A07 | PASS | tenants: falha, retry e download usam o destino da organização |
| A08 | PASS | integration-runtime + tenants sem origem MANAGED global |
| A09 | PASS | tenants: tentativa de provisionar EXTERNAL não chama HTTP com platform token |
| A10 | PASS | tenants + control-storage: rotação, concorrência e invalidação de evidência |
| A11 | PASS | control-auth/HTTP: chave específica não abre endpoints genéricos |
| A12 | PASS | E1 PG: revoga grants, membership, usuário, credencial, empresa, destino e identidade; próxima operação negada |
| A13 | PASS | onboarding: chamadas concorrentes/replay com IDs persistidos e uma criação |
| A14 | PASS | onboarding e contrato HTTP: hash diferente recusado por conflito |
| A15 | PASS | onboarding: serviço reiniciado entre etapas; IDs anteriores reutilizados |
| A16 | PASS | onboarding: perda de resposta/lease UNKNOWN, reconciliação sem repetir criação |
| A17 | PASS | health: READY, CONNECTED e OPERATIONAL separados; assinatura e duas direções recentes |
| A18 | PASS | B6/E3/E5: janela no servidor, fake timers UI, Chrome expira cinco minutos e remove desafio; modal Vue limpa ao encerrar |
| A19 | PASS | control-health: agente não aprova identidade; mudança após claim bloqueia envio e preserva fila |
| A20 | PASS | onboarding/integração: caixa incompatível ou webhook ocupado recusado sem autorização |
| A21 | PASS | signatures/events + control-health: assinatura inválida não cria prova nem job |
| A22 | PASS | qr-chatwoot-storage/events: duplicatas, entrada, nota privada e eco |
| A23 | PASS | J5 entre processos: gateway falha 503 antes do Broker; WebhookJob reenvia HMAC/corpo/ID e replay persiste um job. ActiveJob adianta retry; restart Sidekiq e emissor externo NÃO testados |
| A24 | PASS | Requests/policies Rails J1/J2: conta e inbox alheias negadas antes da chamada Broker |
| A25 | PASS | J1 cifra por conta, serializers filtrados J4; J5 scanner de 17 arquivos e 477 assets sem credenciais sintéticas |
| A26 | PASS | J5 contrato TLS Rails→Broker→Rails: observações separadas por 150ms sem transação retida durante callback; três exemplos PASS |
| A27 | PASS | J4 policies por inbox/grant; E1 banco, E3 Chrome limpa após revogação; E4/E5 descartam respostas atrasadas |
| A28 | NOT_RUN | Regressão delimitada J5: 211 RSpec, 15 Vue, desktop/mobile; NICO/Comercial integral não executada. Build Docker CI bloqueado por memória |
| A29 | PASS | E2 Chrome + servidor web real: /jrc, /login, /dashboard e /embed/authorize com DENY/ancestors none |
| A30 | PASS | E2 Chrome: ancestor exato permitido, outro negado; revogação/flags/policy indisponível fail-closed. Proxy remoto BLOCKED |
| A31 | PASS | E3 parser + Chrome: origem/janela/contexto adulterados não autenticam; currentAgent ignorado; conta errada encerra acesso |
| A32 | PASS | E3 Chrome com restrição de cookies de terceiros e popup bloqueado; link first-party exige login/grants |
| A33 | PASS | E1 PostgreSQL: exchanges concorrentes emitem um token, expiração/prova inválida/negação/replay recusados |
| A34 | PASS | E5 HTTP com corpos válidos: token limitado recusado em instâncias, mensageria e cadastro administrativo (401), disconnect ausente (404), revogação (403); zero side effects |
| A35 | PASS | E4 remoção/reconciliação do app não altera a conta; E5 matriz transporta sem app e com flags off; portal independente em E4/J3 |
| A36 | PASS | E4 sete testes PG: lease entre réplicas, URL exata, UNKNOWN antes do POST, restart sem repetição, 403/404 manual, credencial alterada recusada |
| A37 | PASS | E5 configuração/DTO/UI e matriz com flags off; E2 header/HTTP bloqueados; J5 flag preserva webhook e retry; nenhum logout executado |
| A38 | PASS | E5 chatwoot-media-matrix: seis casos, doze direções, bytes/HMAC/mappings/filas/duplicatas e WebP→sendSticker; HTTP sintético, reprodução/telefone remoto BLOCKED |
| A39 | PASS | qr-chatwoot-storage/messaging: ID upstream, estados persistidos e conciliação de entrega incerta |
| A40 | PASS | J3/J5 Chrome: criação nativa até pareamento sem conversa; E4 portal usa status/pair/grants diretamente, sem depender de iframe |

O navegador local também validou solicitação de destino pendente, recarga e troca
de organização sem pedir token antes da aprovação, em desktop e mobile.

## Limites de liberação

Esta matriz **não libera produção**. Repetir o build Docker do JRC Conversas em
ambiente com memória suficiente; conferir NICO/Comercial integral no CI; homologar
headers efetivos de Traefik/CDN; verificar capacidades/retry do Chatwoot externo;
executar piloto com telefone de teste autorizado e anexos reais. Estes gates não
foram convertidos em PASS. Não houve push, merge, publicação ou deploy.
