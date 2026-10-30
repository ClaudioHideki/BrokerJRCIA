# Evidência atual do servidor — leitura em 30/10/2026

Fonte: interface autenticada Dokploy, serviço `jrc-broker-broker-ophydn`; Config dos containers API/web/Evolution e terminal PostgreSQL136619803d90. Consultas READ ONLY/ROLLBACK, timeout10s nas consultas de incidente. A transcrição abaixo foi conferida nas capturas do terminal exibidas durante a sessão. Não é dump do banco nem exportação de ENV. Horários UTC.

## Identidade da publicação

API container d82eb3c44892, criada03:48:43.661Z, iniciada03:48:55.770Z, healthy, RestartCount0.
Config.Image: `ghcr.io/claudiohideki/brokerjrcia-api@sha256:fb54ad27beeb3e7777703959e08a13e0dd5da8b6f101f6d5e56d711d1af484e5`.
ImageID local: `sha256:6a82035d48f2afea0a4f533e962c32b3696cbb69ac832db4b674f82972553f3b` (config ID, diferente do digest de manifesto multiarch).

Web2151025cd209, running, RestartCount0.
Config.Image: `ghcr.io/claudiohideki/brokerjrcia-web@sha256:1485c277f2e72d2b85e346d75d77dc5775c262a7cb389ffff16c39fb891059c4`.

Evolutionefcb5c1bafce, Up6weeks, RestartCount46 histórico.
Config.Image: `evoapicloud/evolution-api:v2.3.7@sha256:1bd8afc4a6cf48822e6cf02469aeae7bd35a12a6b616eacd1291926307f4d339`.
ImageID: `sha256:385a3c4bedf42c66b46b43d06aae8712620144a84aa3b2c831b30c68435ab27c`.
Memory2147483648; NanoCpus2000000000; LOG_LEVEL não definido explicitamente.
Não foi inferida causa para os46 reinícios, nem equivalência do código-fonte da engine.

Journal PostgreSQL:

```text
count|latest|fingerprint
77|1794177600000|0b6c21a5cb58605eee93023a92252341
```

HTTP público /ready200 `{"status":"ready"}`; /200 text/html. Sem autenticação, alteração ou webhook.

## Incidentes — fotografia sequencial

Consulta inicial em12:06:47.844735Z, agrupamento posterior próximo:

```text
FAILED|MIRROR_MESSAGE|GROUP_CENTRAL_SCOPE_CHANGED|233
FAILED|MIRROR_MESSAGE|CHATWOOT_ATTENDANCE_POLICY_REQUIRES_CONFIGURATION|119
FAILED|MIRROR_MESSAGE|CHATWOOT_INVALID_RESPONSE|19
FAILED|MIRROR_MESSAGE|CHATWOOT_REQUEST_REJECTED|9
FAILED|MIRROR_MESSAGE|MEDIA_DOWNLOAD_FAILED|5
FAILED|CHATWOOT_REPLY|CHATWOOT_CONVERSATION_ALREADY_BOUND|5
UNKNOWN|MIRROR_MESSAGE|CHATWOOT_OUTCOME_UNKNOWN|4
FAILED|MIRROR_MESSAGE|MEDIA_TYPE_UNSUPPORTED|2
FAILED|MIRROR_MESSAGE|MEDIA_SIZE_LIMIT|2
FAILED|CHATWOOT_REPLY|CHATWOOT_CYCLE_CONTACT_CHANGED|1
DATES|UNKNOWN|2026-10-20|2026-10-27
DATES|FAILED|2026-10-02|2026-10-30
```

Totais da consulta seguinte (aproximadamente12:08UTC):

```text
TOTAL|FAILED|396
TOTAL|UNKNOWN|4
TOTAL|SUCCEEDED|3686
TOTAL|PENDING|1382
```

`partner_event_deliveries GROUP BY status` retornou zero linhas. A fila parceira não possui entregas nessa fotografia; isso não prova o comportamento de ponta a ponta de um parceiro real.

```text
# jobs atualizados depois de03:48:55Z
RECENT|1|FAILED|GROUP_CENTRAL_SCOPE_CHANGED|23
# backlog por inbox, intervalo de criação
PENDING|13|1351|2026-10-20|2026-10-30
PENDING|19|26|2026-10-22|2026-10-23
PENDING|14|5|2026-10-20|2026-10-20
```

Saúde: `inbox|status|observed_connected|identity_error|access_error|callback_nonnull|observed_at`:

```text
1|READY|t|||t|2026-10-30 12:08:00.337352+00
13|DISABLED|f|||f|2026-10-30 12:08:02.201831+00
14|READY|f|||f|2026-10-30 12:08:02.131107+00
19|READY|f|||t|2026-10-30 12:07:58.959849+00
```

Grupos: `inbox|instance_status|has_catalog|catalog_current|last_error_code|selected|webhook_phase`:

```text
1|CONNECTED|t|f|GROUP_MEMBERSHIP_CHANGED|0|CONFIRMED
13|DISCONNECTED|t|f|PROVIDER_TIMEOUT|0|CONFIRMED
14|DISCONNECTED|f|||0|
19|DISCONNECTED|t|f|PROVIDER_TIMEOUT|0|CONFIRMED
```

UNKNOWN: `inbox|operation|attempts|created_date|updated_date`:

```text
13|SEND_MESSAGE|1|2026-10-21|2026-10-21
1|SEND_MESSAGE|1|2026-10-20|2026-10-20
1|SEND_MESSAGE|1|2026-10-26|2026-10-26
1|SEND_MESSAGE|1|2026-10-27|2026-10-27
```

## Configuração de recuperação

Dokploy General: BrokerJRCIA.git, main, ./infra/dokploy/compose.yaml, autodeploy off.
Backups: `No backups configured`. Volume Backups: `No volume backups`.
Isso não exclui eventual snapshot/rotina externa; não houve evidência atual dela. Não foi criado backup nem alterada configuração.

## Limitações deliberadas

Não foram consultados conteúdos, números de telefone, mensagens, tokens ou secrets. Nenhuma API de retry/reconcile com efeito colateral foi chamada. Não foram baixadas respostas HTTP remotas antigas; apenas códigos agregados e estado atual. Os IDs de caixa são úteis para operação interna, não incluem identificação pessoal. Contagens podem aumentar após esta fotografia.
