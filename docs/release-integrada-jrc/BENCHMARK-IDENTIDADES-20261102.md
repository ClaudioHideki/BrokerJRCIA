# Reconciliação independente dos eventos sintéticos

O benchmark anterior comparava totais. Contagens iguais podem esconder IDs trocados, payload errado ou duplicação entre empresas. A nova verificação compara um manifesto gerado antes do envio com linhas lidas diretamente do PostgreSQL de laboratório: `(organizationId,eventId)`, SHA-256 dos bytes originais, cursor, sequência, envelope completo e projeção. Os dois tenants usam deliberadamente IDs de eventos coincidentes para testar o escopo composto.

## Implementação e testes

- `labs/cclx-postgres-simulator/identity-reconciliation.mjs`: reconciliação pura e resultados por empresa; duplicatas no manifesto são erro de entrada.
- `identity-reconciliation.test.mjs`: RED4 → GREEN4, cobrindo totais iguais com identidade errada, colisões entre tenants e alterações de hash/conteúdo/projeção.
- `benchmark.mjs` e `benchmark.test.mjs`: manifesto independente, consulta SQL final e métricas por tenant. `test:cclx-receiver` inclui a nova suíte.
- GREEN PostgreSQL + funções puras: **6/6, zero falhas, 960,529ms, exit0**; `output/integral-benchmark-postgres-green.log`.
- Revisão independente não encontrou P1/P2. Um tenant sem amostras deve ser identificado por `latencySamples: 0`; percentil zero nesse caso não é latência medida.

## Rodada finita de 02/11/2026

Comando: `node labs/cclx-postgres-simulator/benchmark.mjs --lab-only`, usando apenas `TEST_DATABASE_ADMIN_URL` do laboratório loopback autorizado. Resultado: exit0, `output/integral-benchmark-20261102.json`.

| Eventos únicos | p50 (ms) | p95 (ms) | Máximo (ms) | Etapa (ms) |
|---:|---:|---:|---:|---:|
| 50 | 13,174 | 40,521 | 57,361 | 242,214 |
| 100 | 14,195 | 131,620 | 196,510 | 677,319 |
| 200 | 11,861 | 26,144 | 40,245 | 745,130 |
| 400 | 11,253 | 51,671 | 250,152 | 1978,416 |

750 eventos únicos, 825 requisições, 750 aceitos, 75 duplicados reconhecidos, zero erros. Todas as identidades, hashes, envelopes e projeções coincidiram em ambos os tenants. Tempo total registrado: 4094,971ms, incluindo preparação e excluindo limpeza. Cada etapa usa no máximo quatro requisições simultâneas; os limites de 400/etapa e 750/rodada foram preservados.

## Limites da evidência

São requisições injetadas no receptor de laboratório com PostgreSQL real; não são sessões Evolution, entrega WhatsApp, tráfego de produção ou integração CCLX instalada. Não há fila nesse percurso (`endingBacklog: null`), mídia, S3 ou rede de cliente neste benchmark. A rodada não prova 250 mil mensagens/dia, 400/900 sessões ou SLO operacional. B14 do worker de parceiro exige teste próprio de receptor lento e justiça entre tenants. Nenhuma configuração produtiva foi alterada.
