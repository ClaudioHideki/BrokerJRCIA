# Simulador CCLX — base disponível e extensão integrada

Pacote existente: `evidencias/baseline-20261030/simulador/`. Evidência anterior36 testes e smoke8 eventos/1 recibo de mídia. Esta frente leu os relatórios e contrato do worker real; não executou novamente o simulador nem carga.

## O que funciona no pacote local

SQLite WAL/FULL guarda inbox, envelope/hash e projeção; ACK202 após COMMIT. Deduplicação por tenant/eventId; conflito de payload rejeitado. Lost ACK/restart têm testes. Mídia grava arquivo privado com hash incremental, sync e rename antes do recibo SQL.

Estado COPY_PERSISTED_UNVALIDATED não equivale a READY. Arquivo e SQL não são transação única; órfão é possível e deve ser reconciliado por hash. Sem fsync de diretório comprovado, não declarar resistência a queda elétrica. Fonte permanece conservada.

## Contratos reais a reutilizar

| Contrato | Comportamento |
|---|---|
| signPartnerEvent | HMAC de timestamp.eventId.body com bytes exatos |
| Envelope | schemaVersion,eventId,cursor string,organizationId,type,occurredAt,data |
| Delivery | Até10 tentativas, lease30s, timeoutHTTP10s;2xx entrega;5xx/408/425/429 retentáveis |
| Replay | POST /v1/partner-webhook-deliveries/{id}/replay; scope webhooks:manage; Idempotency-Key UUID; somente FAILED retido |
| Feed | GET /v1/partner-events?after=...; cursor string; limite100; retenção30dias;409 expirado |
| Mídia privada | GET /v1/messaging/media/{id}; autenticação e revalidação antes dos bytes |
| Custódia | POST /v1/media-custody/receipts; media:archive; hash/tamanho/ref; KEEP e physicalStorageVerified=false |

Quatro tipos de evento reais: received,created,status e connection.status (nomes completos conforme schemas). O receiver de fixture recebido não representa automaticamente todos. Maior cursor recebido fora de ordem por webhook não é checkpoint seguro do feed.

## Harness integrado proposto

1. Cluster PG e bucket privados descartáveis; marcador de lab e credenciais sintéticas.
2. Banco Broker e banco receptor separados. Inbox+job do receptor no mesmo COMMIT antes do ACK.
3. Worker Broker real com claim/authorize/settle reais. Injetar somente send para URL exata `https://cclx-lab.example.test/hooks`, encaminhando ao loopback controlado. Nenhuma mudança no validador SSRF produtivo.
4. Consumidor assíncrono com efeito único por tenant/eventId; mídia fora da transação longa.
5. Download Broker autenticado→temporário→hash/tamanho/validação→objeto privado→receipt SQL; depois POST real de custódia idempotente.
6. Restore vazio de bancos+objetos+checkpoints; reconciliar antes de carga.

Uma chamada direta ao receiver prova o receiver; não prova claim/lease/settle Broker. Um mock de SQL não prova fencing/RLS. A versão PG/S3 ainda é pendência interna JRC, não dependência exclusiva do CCLX.

## Falhas obrigatórias

Antes do COMMIT, depois do COMMIT/antesACK, worker kill, lease expirada e settlement antigo,5xx/429/4xx, PG indisponível, revogação em I/O, cursor expirado, eventos fora de ordem, dois tenants com IDs iguais, arquivo parcial/objeto corrompido, PUT com resposta perdida e ACK de custódia perdido.

Aceite: um efeito por intenção, eventos aceitos recuperáveis, bytes corretos, zero acesso cruzado e nenhum DELETE de origem. API de custódia retorna declaração válida sem transformar physicalStorageVerified em true. Envio WhatsApp deve permanecer bloqueado/stub no laboratório.

## Limite

O simulador comprova obrigações contratuais sob condições controladas. Não valida versão/fork/jobs/PubSub/grants do cliente, operação de backup CCLX ou custo real de900 sessões. Um smoke funcional é avanço útil, mas capacidade precisa campanha própria.
