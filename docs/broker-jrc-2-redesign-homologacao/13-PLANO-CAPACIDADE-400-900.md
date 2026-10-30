# Plano de capacidade 400/900 — sem certificação antecipada

Estado em30/10/2026: benchmark **PENDENTE**;900 **PREPARAÇÃO**. Nenhuma carga foi executada nesta frente. Fonte detalhada: `evidencias/baseline-20261030/simulator-benchmark.md` e benchmark-plan.json.

## Modelo de carga

250.000 mensagens/dia =2,893519 mensagens/s em24h ou8,680556/s em8h. Essas médias não dimensionam picos. Sessões conectadas, mensagens lógicas, eventos, deliveries, tentativas, mídia e histórico são contadores diferentes.

Eventos/s = mensagens/s × eventos únicos por mensagem. Deliveries/s = eventos/s × fanout. Retries acrescentam tentativas. Memória por sessão/engine e bytes de mídia devem ser medidos separadamente.

| Cenário | Taxa lógica proposta | Natureza |
|---|---:|---|
|24h uniforme |2,893519/s | Média aritmética |
|8h concentrado |8,680556/s | Hipótese |
| Pico5×/10× base24h |14,467593/28,935185/s | Sensibilidade, não pico observado |
| Pico5×/10× base8h |43,402778/86,805556/s | Sensibilidade separada |

Mix70%texto/30%mídia é proposta anterior, não medição. Definir tamanhos p50/p95/max, fanout, fração inbound/outbound, tipos, instâncias ativas/ociosas, reconnect, histórico e distribuição hotspot80/20. Sem mix identificado, resultado é inconclusivo.

## Progressão

| Gate | Escopo | Condição |
|---|---|---|
| G0 | Isolamento, contrato, observabilidade, restore | Identidade de ambiente e recuperação demonstradas |
| G50 |50 sessões lógicas |3 repetições e reconciliação |
| G100 |100 |G50 aprovado |
| G200 |200 |G100 aprovado, sem starvation |
| G400 |400 |G200 aprovado, hotspot/fairness/recuperação |
| G900 |900 |Planejamento após400; execução futura separada |

Sessão lógica simulada não prova custo de sessão física WhatsApp. Homologação da engine exata exige etapa própria controlada, sem duplicar sessões reais.

Proposta por gate:15min warmup+60min steady,3 repetições, pico5×5min, recuperação15min, pico10×5min e drain. Soak24h é campanha separada. Bursts somam volume; ajustar orçamento para declarar250k exatos. p99 exige amostra suficiente, candidato mínimo10mil observações por estágio.

## SLOs candidatos, a ratificar

API p95≤500ms/p99≤2s; commit+ACK receptor p95≤250ms/p99≤1s; outbox→stub p95≤2s/p99≤5s. Zero perda de IDs aceitos, zero duplicidade de efeito, zero escape tenant,100% reconciliação após drain. Percentis são por tenant e etapa, sem média de p95 entre nós.

B14 deve ter tenant lento com timeout e tenant pequeno rápido; scheduler atual até20 operações sequenciais pode consumir aproximadamente200s antes de avançar, cenário derivado, não medição. Medir espera máxima e p95/p99 por tenant antes de propor concorrência.

## Telemetria e abort

Coletar CPU/RSS/GC, restart/OOM; pools/locks/WAL/IO/fsync PG; Redis evictions/rejected writes; backlog/oldest/throughput/drain; lease/retry/lifetime; bytes/hash/cópia. Incluir engine, rollout, importadores e reservas no orçamento de pools.

Candidatos de interrupção: integridade/tenant imediatamente; OOM; CPU ou RSS≥90% por60s; erros inesperados>5% por60s; PG conexões≥90% por60s; disco livre<max(15%,10GiB). Preservar ledger e executar drain/reconciliação após interrupção segura.

## Entrega exigida

Manifesto hardware+SHA+digests+schema+mix+taxa+duração+falhas, dados brutos sanitizados, histogramas, reconciliação e decisão por gate. Não há GO400 ou Ready900 apoiado nesta frente. Limites do Compose e planner de pools são entradas de teste, não resultado.
