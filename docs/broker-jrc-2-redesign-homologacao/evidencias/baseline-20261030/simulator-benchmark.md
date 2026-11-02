# Reconciliação do simulador CCLX e benchmark — 30/10/2026

**Resultado:** pacote local executável entregue em `simulador/`, com persistência SQLite real, ACK após commit, deduplicação por tenant/eventId, falhas e mídia em arquivo sincronizado. **PostgreSQL/S3/CCLX real e capacidade permanecem não homologados.** Benchmark 50/100/200/400 foi preparado; 900 permanece preparação. Nenhuma carga de produção, sessão WhatsApp, mudança no Engine, push, deploy ou migration externa foi executada.

## Base e origem

Checkout inspecionado: `C:/Users/DEV02/Documents/ChatGPT/New project/BrokerJRCIA-source-audit/.worktrees/image-release-20260924`, HEAD `d1b66a56fe6d4f9202969784301abdf61490db45`. `AGENTS.md` exige projeto/plano lidos, TDD e ausência de deploy sem tarefa de release. Foram lidos o plano `docs/auditoria-900/00-PLANO-AUDITORIA-E-HOMOLOGACAO.md`, contrato 08, benchmark 11 e README do lab. Os documentos/receptor antigos estão **untracked**, não devem ser apresentados como conteúdo desse commit. O plano antigo cita baseline `9e62...`; a reconciliação abaixo usa fontes correntes.

Origem copiada para o pacote, sem modificar os arquivos originais:

| Arquivo original em `docs/auditoria-900/lab/` | SHA-256 da cópia-base lida |
|---|---|
| `cclx-receiver.mjs` | `B2CAD866F297A30E58A88BA7DF70A2F63ED89E7668792BBE681F0FADF9B81CC4` |
| `cclx-receiver.test.mjs` | `7C20737EEE3736F213F694FACF3F61B15B19FE60AE6B084DDEABBEDC7148C4FB` |
| `run-safe-tests.mjs` | `EB21A628E2B9778074EC0C0B836AEF19662B4C85BD8DEFB49D9DAA54304C9998` |

O pacote adaptado não é substituto do CCLX: apenas laboratório separado. O segredo nele é público, fixo e exclusivamente de fixture.

## Reconciliado: existente, ampliado e faltante

| Requisito | Existia na base | Entregue nesta complementação | Prova ainda faltante |
|---|---|---|---|
| Persistência de eventos | SQLite WAL/FULL, envelope+hash, inbox e projeção na mesma transação | Preservado, com schema local v3 e dois tenants reservados | PG real do receptor, concorrência de múltiplos processos, RLS, restauração e pool |
| ACK e idempotência | 202 após COMMIT, duplicate sem novo efeito, conflito 409 | Preservado e smoke com leitura após reinício | Worker Broker+receptor integrado sob falha e lease reais |
| ACK perdido/restart | Já existiam lostAckAfterCommit, reopen e kill abrupto em outro processo | Smoke reencontra oito eventos e o recibo de mídia | Perda elétrica/disco, restauração, restart PG e crash durante cópia |
| IDs/cursor/tenant | 10 mil IDs possíveis, cursor de 16 dígitos, um tenant | 12 dígitos reservados de ID, BIGINT string canônica, tenants 0900/0910 | Payloads reais dos quatro tipos de evento; grants/bindings do CCLX |
| Mídia | Iterador de bytes em memória; hash e sniff; nenhum destino persistido | Arquivo privado gerado, hash incremental, sync, rename e recibo SQLite após COMMIT | Download real autenticado do Broker, S3 privado, validadores de codec/documento, backup/restore |
| ACK de cópia | Não havia no receptor antigo; o Broker atual já possui recibo declaratório media-custody | `ACK_COPY_PERSISTED_LAB`, somente retorno local após commit | Integrar com POST media-custody/receipts; prova física e expurgo continuam ausentes, KEEP/physicalStorageVerified=false |
| Carga | Plano 50/400/900, SKIP_LOAD | Plano executável que imprime 50/100/200/400 e preparação900; smoke fixo de oito eventos | Runner de carga com scheduler/telemetria e ambiente real descartável |

A fixture de mídia copiada termina em `COPY_PERSISTED_UNVALIDATED`, nunca READY. Isso significa bytes gravados e registrados localmente; não significa documento decodificável ou mídia definitiva do cliente. O arquivo e o SQLite não compartilham uma única transação: publicar arquivo antes do recibo torna possível um órfão, tratado pelo retry com verificação de hash. Fonte nunca é apagada. `sync()` de arquivo não prova durabilidade do rename em perda elétrica; não há fsync de diretório comprovado neste Windows.

## Contratos reais que o próximo harness deve reutilizar

Referências abaixo são relativas ao checkout inspecionado.

| Contrato existente | Referência | Uso no laboratório e limite |
|---|---|---|
| HMAC e envelope `schemaVersion/eventId/cursor/organizationId/type/occurredAt/data` | `apps/api/src/modules/partner-events/worker.ts:13`, `:30`, `:61` | Assinar bytes exatos; quatro tipos reais: received/created/status/connection.status. O receptor atual aceita apenas fixture received |
| Configurar endpoint | `apps/api/src/http/routes/partner-webhooks.ts:46` | `POST /v1/partner-webhooks`, scope `webhooks:manage`, segredo próprio. Default exige origem HTTPS segura |
| Feed e checkpoint | `apps/api/src/http/routes/partner-webhooks.ts:12`, `:48` | `GET /v1/partner-events?after=<string>&limit<=100`; retenção30dias, 409 cursor expirado. Não usar maior cursor de webhook como checkpoint de polling |
| Replay de delivery | `apps/api/src/http/routes/partner-webhooks.ts:43`; `apps/api/drizzle/migrations/0077_partner_delivery_replay.sql:97` | **Já existe** `POST /v1/partner-webhook-deliveries/{id}/replay`, API key com `webhooks:manage`, body `{}`, Idempotency-Key UUID. Só FAILED retido, mesmo evento/destino; não é reenvio WhatsApp |
| Estatística de delivery | `apps/api/src/http/routes/partner-webhooks.ts:44`; migration0077`:158` | `GET /v1/partner-webhook-delivery-stats?endpointId=<uuid>`, contagens, oldestPendingAt, expiredLeases, replays, lifetimeAttempts |
| Worker/lease | `apps/api/src/modules/partner-events/worker.ts:23`, `:38`, `:45`, `:66` | Até10 claims por ciclo; lease30s; HTTP10s; payload2MiB; resposta64KiB. 2xx entregue; 5xx/408/425/429/rede retentáveis; demais não2xx terminais. Replay explícito reabre ciclo preservando ledger/lifetime |
| Upload e metadados | `apps/api/src/http/routes/messaging.ts:288`, `:298`, `:316` | `POST /v1/messaging/channels/{id}/media`, octet-stream, headers x-jrc-media-mime/kind/name, UUID idempotente, scope media:upload; `GET .../media/{mediaId}` |
| Leitura privada | `apps/api/src/http/routes/messaging.ts:398` | `GET /v1/messaging/media/{id}` autenticado, revalidação antes de bytes; não inventar URL pública S3 |
| Recibo declaratório de custódia | `apps/api/src/http/routes/media-custody.ts:33`, `:36`, `:37`; `packages/contracts/src/media-custody.ts:4`, `:14` | **Já existe** POST `/v1/media-custody/receipts`, API key `media:archive`, Idempotency-Key UUID; GET porid e GET `/{id}/retention`. Atestação DURABLY_STORED declarada pelo cliente; política KEEP, eligibleForDeletion=false e physicalStorageVerified=false |
| Envio público de parceiro | `apps/api/src/http/routes/messaging.ts:326`, `:335` | `POST .../partner-media` e `.../partner-text`, 202 fila. Envio permanece stub no laboratório; replay/catch-up não produz nova intenção |

**Correção documental necessária:** `docs/auditoria-900/08-CONTRATO-CCLX.md` afirma que não há replay público e trata ArchiveReceipt como futuro. Está desatualizado no HEAD d1b66a: replay/migration0077 e recibos declaratórios media-custody já existem, com testes. O recibo atual valida referência/tamanho/hash contra mídia READY do Broker e registra a declaração do cliente; não verifica o armazenamento físico do cliente. A parte ainda faltante é a prova operacional de download/cópia/backup/restore e eventual protocolo de expurgo, que permanece bloqueado por KEEP. A rota real chama-se `/v1/media-custody/receipts`, não `/archive-receipt`.

O worker real chama `normalizeWebhookUrl` antes de `options.send` e recusa loopback/HTTP/IP/porta customizada (`worker.ts:7`; `integrations/chatwoot-destination.ts:12`). **Não afrouxar essa proteção para o laboratório.** O harness futuro pode registrar apenas a origem sintática `https://cclx-lab.example.test/hooks` no banco descartável e injetar `options.send` que exige igualdade exata desse URL e encaminha somente ao receiver127.0.0.1 gerado internamente, sem DNS/fallback externo. Assim se exercita claim/sign/settle real com PG e HTTP local, sem tocar Engine ou transporte produtivo.

## Execução e evidências atuais

Node observado: v24.19.0. Resultados nesta frente, sem inferir testes de outros executores:

| Verificação | Resultado |
|---|---|
| Receptor original: `node docs/auditoria-900/lab/run-safe-tests.mjs --lab-only` | 28/28, exit0, 12.360665s; não benchmark |
| Broker: worker.test.ts, replay.test.ts, HTTP partner-webhooks.test.ts via Vitest maxWorkers1 | 3 arquivos/20 testes, exit0,21.15s; SQL/HTTP injetados, sem PG real |
| TDD extensão: `node --test extended.test.mjs` antes da implementação | RED5/5: ID250001 recusado e persistMedia ausente |
| TDD cenário: `node --test scenario.test.mjs` antes da implementação | RED2 cenários por módulo ausente; teste de rejeição endurecido para exigir erro esperado |
| Pacote: `node run-safe-tests.mjs --lab-only` após complementação | 36/36, exit0; base28 + extensão5 + cenário3 |
| Smoke explícito | acceptedUnique8=inbox8=projections8; mediaReceipts1; lostEventAck/lostMediaAck/readback=true; capacityValidated=false |
| Plano explícito | G50/G100/G200/G400 SKIP_LOAD; G900 PREPARATION_ONLY |
| Produto | `git status --porcelain --untracked-files=no` vazio; `git diff --check` exit0 no checkout; não inclui validação de arquivos untracked |

Logs e JSON de execução são gravados ao lado deste relatório como evidência; reexecutar é seguro com os comandos do README do pacote. Duração de teste é tempo do runner, não throughput nem latência de serviço.

## Complementação local implementável em etapas

1. **Adaptador de contrato e fixture:** acrescentar quatro schemas sintéticos compatíveis com `EventSchema`, `MessageProjection`, status fora de ordem, binding desconhecido em quarentena e mesmas chaves em tenants A/B. Manter whitelist de tenants/IDs e recusa de conteúdo externo. Payload de mídia referencia mediaId sintético; não abrir URL do payload.
2. **PostgreSQL receptor separado:** adicionar `lab_inbox(tenant,event_id PK,raw_hash,envelope_jsonb,committed_at)`, `lab_jobs` e `lab_projection`; inbox+job num COMMIT antes202. Consumidor assíncrono com unique por tenant/evento e claim/lease fenced; receiver não deve segurar transação enquanto baixa mídia. RLS/role própria, pool limitado, migrations só no banco marcado do lab. Preservar SQLite como smoke portátil.
3. **Broker PG existente:** usar factories/test helpers de `apps/api/tests/integration/partner-events.test.ts` e `partner-delivery-replay.test.ts`, sem recriar fila em Redis. Banco Broker e banco receptor separados no cluster descartável. Cliente de replay/catch-up usa API real via Fastify.inject ou cliente HTTP estritamente local, nunca SQL direto para resetar tentativas fora da fixture de falha.
4. **Storage privado:** usar a interface `PrivateObjectStore` e ensaios `apps/api/tests/storage/private-media-minio.test.ts` como referência. Configuração/bucket próprios do cliente; download local de endpoint Broker autenticado para temporário→hash/tamanho/validação real→objeto privado→receipt SQL. Uma falha de PUT/timeout/restart deixa estado recuperável e nunca READY/receipt definitivo; ausência de recibo conserva origem. Não confundir ETag multipart com SHA-256. Validar leitura sem credencial negada e leitura tenantB negada. Depois do commit local, exercitar a rota real POST `/v1/media-custody/receipts` via Fastify.inject/local, com key media:archive e UUID idempotente, schemaVersion1, channelId/messageId/mediaId/endpointId sintéticos válidos, destinationVersion1, clientReceiptId estável, byteSize/sha256 da cópia, storageObjectId opaco e attestation DURABLY_STORED. Perder a resposta e repetir mesma intenção deve retornar mesmo recibo/replayed=true; conflito deve dar409. GET do recibo e GET `/{id}/retention` precisam confirmar KEEP/eligibleForDeletion=false/physicalStorageVerified=false. Conferir zero DELETE no objeto de origem. Reusar `apps/api/tests/integration/media-custody.test.ts`; isso prova contrato declaratório, não torna a verificação física true.
5. **Matriz de falhas:** antes de commit, durante commit, após commit/antesACK; receiver/worker kill, lease expirado e stale settlement; retry5xx/408/425/429/timeout; 4xx permanente; replay idempotente FAILED/expirado/revogado; PG indisponível; cópia parcial/storage lento/PUT com resposta perdida; cursor expirado; tenants colidentes; revogação duranteI/O. Falhas são janelas identificadas, sem misturar erro injetado com erro saudável.
6. **Restore e carga:** restore DB+objetos+checkpoints em destinos vazios; conferir IDs e hashes sem novo envio. Depois runner com limites fixos por manifesto, contadores e histogramas por tenant/camada, stop preservando ledger. Só então campanha progressiva abaixo.

Preflight do futuro runner deve rejeitar URL fora de loopback/serviço de rede isolada criado por ele, banco/bucket não marcados e qualquer configuração herdada de produção. O helper PG existente lê TEST_DATABASE_ADMIN_URL sem validar host (`apps/api/tests/integration/helpers/postgres.ts:19`), portanto **não basta exportar uma variável de teste**. Os testes criam/deletam DB e migrations podem alterar roles do cluster: usar cluster dedicado. Storage já exige loopback e release/hash específicos (`apps/api/tests/storage/environment.ts:1`). Recovery também exige Redis e pg_dump/pg_restore (`apps/api/tests/recovery/recovery.lab.test.ts:27`), destino vazio e configuração própria.

Após esse preflight, os comandos existentes reaproveitáveis são:

```text
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts apps/api/tests/integration/partner-events.test.ts apps/api/tests/integration/partner-delivery-replay.test.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts apps/api/tests/integration/partner-media-store.test.ts apps/api/tests/integration/partner-media-send.test.ts --maxWorkers=1
npm run test:storage
node node_modules/vitest/vitest.mjs run --config vitest.recovery.config.ts
```

Esses comandos não foram executados nesta frente e não inicializam, por si sós, uma infraestrutura segura. O pacote entregue pode ser executado agora; a extensão PG/S3 acima exige implementação do preflight e recursos descartáveis. Não foi inventado comando inexistente de benchmark ou endpoint de arquivo/ACK.

## Plano 250.000 mensagens/dia, 50/100/200/400 e preparação900

250.000/dia é total agregado de mensagens lógicas únicas; não por sessão e não a soma de retries/status. O volume fixo entre escalas separa densidade por sessão de overhead. Propõe-se perfil 70%texto/30%mídia como **uma opção a definir**, não como tráfego observado; antes de executar, registrar distribuição real escolhida e tamanhos p50/p95/max. Uniforme e hotspot80/20 são cenários separados. Se não houver mix aprovado, campanha fica INCONCLUSIVA.

| Cenário proposto | Taxa lógica/s | Justificativa |
|---|---:|---|
| 250000 em24h | 2,893519 | Média aritmética diária |
| 250000 em8h | 8,680556 | Hipótese de concentração em expediente |
| Pico5×/10× sobre24h | 14,467593/28,935185 | Sensibilidade a rajadas por5min; não pico medido |
| Pico5×/10× sobre8h | 43,402778/86,805556 | Mesmos multiplicadores sobre base concentrada; não misturar bases |

Eventos/s = mensagens/s × eventos únicos por mensagem; entregas/s = eventos/s × fanout; tentativas acrescentam retries. Medir os fatores, não fixá-los como capacidade. Mídia acrescenta bytes/IOPS/tempo de cópia e nunca deve ser diluída na taxa de mensagens. Polling, importações de histórico e replay têm contadores separados.

| Gate lógico futuro | Média uniforme de mensagens/sessão/dia | Condição para avançar |
|---|---:|---|
| 50 | 5000 | G0 isolamento/contrato/restore e telemetria conhecidos |
| 100 | 2500 | 50 passou três repetições e reconciliação |
| 200 | 1250 | 100 passou sem perda, duplicação ou saturação |
| 400 | 625 | 200 passou; hotspots/fairness e recuperação aceitáveis |
| 900 — preparação | 277,777778 | Plano e capacidade de lab revistos após400; sem execução nesta entrega |

Proposta por gate:15min warmup+60min steady, três repetições; pico5× por5min,15min recuperação, pico10× por5min e drain. Soak24h e concentração8h são campanhas separadas; bursts somam volume se não houver redistribuição explícita do orçamento diário. Não chamar o total com bursts de exatamente250k/dia sem ajustar a taxa restante. Pelo menos10mil observações por estágio para p99; amostra menor é inconclusiva. Coleta a cada5s e histogramas de latência, não média dos p95 de nós.

Reusar as metas candidatas do plano11`:96-110` em todos os gates: API steady p95≤500ms/p99≤2s; receiver commit+ACK p95≤250ms/p99≤1s; worker até stub≤100ms com outbox→stub p95≤2s/p99≤5s. Invariantes obrigatórias: zero perda de IDs aceitos, zero efeito duplicado por replay, zero escape de tenant, 100% de reconciliação após drain e zero exclusão por ACK. SLOs são propostas, não compromissos homologados.

Medir CPU/RSS/GC por processo; PG pools/locks/WAL/fsync/IOPS; Redis apenas onde usado; backlog/profundidade/idade/taxa de drain por tenant; retries/lifetimeAttempts/replays/leases; bytes/hash/cópia; p50/p95/p99 por etapa. Candidatos de abort do plano11: CPU/RSS≥90% por60s, OOM, erro de integridade/isolamento imediato, erros inesperados>5% por60s, disco livre<max(15%,10GiB), PG conexões≥90% por60s. Falta de inventário ou telemetria impede gate. Não inferir300sessões/nó de budget administrativo.

Critério de saída publicável: ambiente+SHA+hardware+mix+taxa+duração+falhas+SLO identificados e todos os gates aplicáveis com evidência reproduzível. Nesta entrega: **36 testes locais e smoke funcional; nenhuma capacidade50/100/200/400/900 e nenhuma sessão física homologada.**
