# Resultados de aceite — execução local

Referência: matriz original em `docs/reference/broker-chatwoot-20260916/docs/validation/`.
Branches: `codex/broker-chatwoot-control` e `codex/jrc-broker-native`.
Commits Broker B1–B6: c47aed4, 998d54f, f1af2fb, b14aae9, 72baa75, 7424fbf.
B7: alterações no mesmo branch; resultados detalhados no diário de execução.

Todos os resultados abaixo são do nível **local**, com PostgreSQL/Redis descartáveis,
identidades sintéticas e fixtures de providers. Níveis Chatwoot remoto e telefone
real: **BLOCKED**, dependem de piloto separado autorizado. Nenhum PASS local equivale
a teste remoto. NOT_RUN também cobre cenários ainda incompletos; a evidência parcial
é descrita sem promovê-la ao cenário completo.

Comandos executados e contagens estão em `2026-09-16-execution.md`; logs locais
sanitizados em `.sessions/b1-*` a `.sessions/b7-*` não são versionados.

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
| A12 | NOT_RUN | B4 valida revogação/suspensão/revisão; falta sessão embed E1 |
| A13 | PASS | onboarding: chamadas concorrentes/replay com IDs persistidos e uma criação |
| A14 | PASS | onboarding e contrato HTTP: hash diferente recusado por conflito |
| A15 | PASS | onboarding: serviço reiniciado entre etapas; IDs anteriores reutilizados |
| A16 | PASS | onboarding: perda de resposta/lease UNKNOWN, reconciliação sem repetir criação |
| A17 | PASS | health: READY, CONNECTED e OPERATIONAL separados; assinatura e duas direções recentes |
| A18 | NOT_RUN | B6 testa janela expirada no servidor; falta tela nativa J3 |
| A19 | PASS | control-health: agente não aprova identidade; mudança após claim bloqueia envio e preserva fila |
| A20 | PASS | onboarding/integração: caixa incompatível ou webhook ocupado recusado sem autorização |
| A21 | PASS | signatures/events + control-health: assinatura inválida não cria prova nem job |
| A22 | PASS | qr-chatwoot-storage/events: duplicatas, entrada, nota privada e eco |
| A23 | BLOCKED | Recuperação antes do ACK ainda não demonstrada. J5 deve corrigir/testar emissor; bloqueia piloto confiável |
| A24 | NOT_RUN | Depende de J1/J2 |
| A25 | NOT_RUN | Depende de J1/J3 |
| A26 | NOT_RUN | B5 verifica ausência de transação Broker durante HTTP; falta contrato entre processos Rails |
| A27 | NOT_RUN | B6 revoga grant na chamada seguinte; falta policy/modal Rails/Vue |
| A28 | NOT_RUN | Depende da regressão J3/J5 |
| A29 | NOT_RUN | Falta teste após implementação do embed |
| A30 | NOT_RUN | Depende de E2 |
| A31 | NOT_RUN | Depende de E3 |
| A32 | NOT_RUN | Depende de E3/E5 |
| A33 | NOT_RUN | Depende de E1 |
| A34 | NOT_RUN | Depende de E1/E5 |
| A35 | NOT_RUN | Depende de E4 |
| A36 | NOT_RUN | Depende de E4 |
| A37 | NOT_RUN | Superfícies Broker desligadas preservam transporte; faltam flags Rails/embed |
| A38 | NOT_RUN | Texto, imagem e anexos múltiplos têm regressão local; falta matriz completa dos seis tipos nos dois sentidos |
| A39 | PASS | qr-chatwoot-storage/messaging: ID upstream, estados persistidos e conciliação de entrega incerta |
| A40 | NOT_RUN | Depende de J3/E4 |

O navegador local também validou solicitação de destino pendente, recarga e troca
de organização sem pedir token antes da aprovação, em desktop e mobile.
