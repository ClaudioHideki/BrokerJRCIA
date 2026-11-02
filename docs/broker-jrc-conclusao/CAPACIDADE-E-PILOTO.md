# Capacidade: plano verificável, não resultado de sessões

250.000 mensagens/dia equivalem a 2,89 mensagens/s em 24h ou 8,68 em 8h. Eventos de status, fanout, consultas, mídia e retries multiplicam esse trabalho. Não dimensionar engines só por essa média ou fixar quantidade de sessões por engine sem medição.

## Carga proposta para laboratório

Premissas iniciais a substituir por medição: 60% entrada/40% saída, 20% mensagens com mídia (distribuir 80% arquivos de 256 KiB, 15% de 2 MiB, 5% de 8 MiB), 20% dos canais concentrando 80% da carga. Medir fanout real por tipo antes de multiplicar eventos. Não chamar 50 eventos de 50 sessões.

Patamares sintéticos: 1x/3x/10x da janela de 8h (8,68/26,04/86,81 mensagens lógicas/s), cada um com 5min aquecimento e 30min coleta, somente após orçamento de CPU/RAM/IO/pools e limites aprovados no laboratório. Não executar contra WhatsApp real. Ensaio acelerado não substitui soak.

Parada inicial proposta, não SLA: CPU sustentada >85% por 5min, RAM >85%, swap crescente, pool >80% do orçamento, backlog cuja idade cresce durante 10min sem recuperação, erros inesperados >1%, qualquer vazamento/efeito duplicado/lacuna não explicada. Medir antes de aumentar limites. Nenhum desses valores foi aplicado a produção.

## Etapas e aceite

| Etapa | Precondição | Prova exigida |
|---|---|---|
| Pipeline sintético | Broker + origem/receptor persistentes isolados | Conjuntos de IDs gerados, aceitos, aplicados, pendentes e terminais reconciliados independentemente; p95/p99 por fronteira, mídia e filas |
| 1–2 sessões reais | Imagem engine final, ownership, permissões e autorização específica | QR, reconexão, logout, entrada/saída/mídia e retomada sob identidade correta |
| 50 números / 30 dias | Bloqueadores internos resolvidos e critérios acordados | Operação e tempo reais, diário por sessão, UNKNOWN conciliado e custódia comprovada |
| 100 / 200 | Medidas da etapa anterior com margem | Comparar engines, RAM, sockets, event loop, CPU, IO, rede, DB/Redis, backlog e reconexão simultânea |
| GO400 | Contratos e seis gates GO400 fechados | Soak 24–72h, perda de nó e destino, sem starvation ou dono antigo transmitindo, margem de recuperação |
| Ready900 | Capacidade por engine medida | Quantidade de engines derivada de resultado e reserva N+1 em domínios de falha; plano de rollout em lotes |

Proposta inicial de metas para discussão: aceite durável interno p95≤1s/p99≤3s em carga contratada; idade de backlog online ≤60s; reconexão transitória p95≤120s; pendência offline de 15min drenada em até30min junto à carga corrente; UNKNOWN investigado em até15min com alerta, sem reenvio. Medir trechos separadamente e revisar com capacidade disponível; não são SLAs aprovados nem prazo de entrega ao destinatário WhatsApp.

O orçamento de PostgreSQL inclui réplicas API, todos os workers, engine, migrator e reserva administrativa. Os 58/100 clientes históricos (9 Broker/49 Evolution) são uma amostra, não pico. Redis/prefixos não isolam CPU/RAM. Nenhuma quota/pool foi aumentada neste incremento.

## Catálogo mínimo de falhas

Broker fora na criação Chatwoot; origem Evolution fora/cheia; PostgreSQL/Redis indisponíveis; crash antes/depois de COMMIT/ACK; resposta perdida após possível envio; HMAC/hash/tenant inválidos; eventos atrasados; reconexão com número diferente; cancelamento/expiração no backlog; mídia parcial/expirada/corrompida; retorno do dono antigo; consumidor lento e tenant saudável. Cada ensaio termina em reconciliação de IDs, não apenas comparação de contadores do sistema.

Resultados desta rodada estão separados no relatório de testes: PostgreSQL/MinIO e E2E com provider sintético não representam sessões reais, piloto de30dias, GO400 ou900 homologados.
