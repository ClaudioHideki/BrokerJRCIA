# Testes e evidências — continuação de 977ab0e

Execução local em 01/11/2026, encerramento em 02/11 UTC (ainda 01/11 em Brasília). Fonte: baseline `977ab0eed78ac3ad1aac75f38e6bba723eb86db2` mais o diff deste incremento. As evidências estão no pacote externo de entrega, pasta `evidencias/`. Não usar a CI histórica de 977ab0e para aprovar este código novo.

## Resultados efetivamente executados

| Verificação | Resultado | Evidência e limite |
|---|---|---|
| Typecheck / compilação TypeScript da API e pacotes | Exit 0; 4,35 s | `typecheck-final.log` e registro do comando/exit; log vazio é normal. Não é build de imagem nem da engine final. |
| Build frontend Vite | Exit 0 | `build-web-final.log`; assets locais. |
| Lint | Não existe script de lint no package.json do Broker | `git diff --check` passou, mas não foi denominado lint. RuboCop completo LAB2 não executado. |
| Regressão ampla Vitest | 465 arquivos: 462 passaram, 3 falharam. Testes: 3.667 passaram, 2 falharam, 4 pulados; 913,11 s | `unit-final.log/json`. Duas expectativas ainda apontavam a migration 0078; setup TLS não encontrou OpenSSL no PATH. |
| Reteste dos três arquivos acima | **11/11**, 3 arquivos; 6,48 s | `unit-retest.log/json`. Expectativas preservam toda a cadeia e acrescentam 0079; OpenSSL local explicitado no PATH. A rodada ampla original permanece registrada, não foi reescrita como toda verde. |
| ACK/HTTP/readiness focal final | **56/56**, 6 arquivos; 8,12 s | `ack-final.log`. Sobrepõe-se à regressão ampla; não somar. |
| PostgreSQL recibos e readiness | **53/53**, 2 arquivos; 25,56 s | `pg.log`; migrations reais em bancos de laboratório, grants, RLS, imutabilidade e drift. |
| PostgreSQL regressão adicional | 23 passaram em 4 arquivos; a quinta suite teve 8 casos pulados por faltar flag exclusiva no runner | `pg-regression.log`; falha de preparação explicitamente preservada. |
| Reteste PostgreSQL replay | **8/8**; 12,19 s | `pg-replay.log`; flag habilitada somente após conferir laboratório exclusivo. Sem replay produtivo. |
| Worker → receptor PostgreSQL + MinIO | RED: HTTP passou, recibo estrito falhou. GREEN: **2/2**, 21,535 s | `red-media.log`, `green-media.log`; COMMIT antes de ACK, perda de socket, retry, uma projeção e recibo estável, readback de bytes sintéticos, KEEP. |
| Crash de origem / composição pinada | **2/2**, 48,288 s | `origin-critical.log`; SIGKILL antes de dispatch e após COMMIT real Broker/PG, restart sem efeito duplicado. Classes pinadas compiladas; WhatsApp, autenticação física e enriquecimento sintéticos. Não é nova imagem completa da engine. |
| LAB2 policy / classes Ruby reais | RED inicial 12 falhas/2 passes; GREEN inicial 14/14; cache modelado RED 16 falhas/4 passes; final **20/20** | `lab2/policy-*.log`; Ruby 3.4.4 isolado, sem rede, fonte real com hashes; repositório/modelo de persistência simulado. |
| Rails request specs LAB2 | Seis casos adicionados, sintaxe validada; **não executados em Rails** | `lab2/REPORT.md`; não confundir o probe Ruby com RSpec, PostgreSQL/Redis Rails ou servidor LAB2. |
| Componentes produto | **13/13**; revisão identificou e corrigiu orientação de HISTORY_UNAVAILABLE | Evidências produto RED/GREEN. A correção teve novo RED 1/13 e GREEN 13/13. |
| E2E desktop/mobile | **41 passaram, 1 skip intencional**, 3,1 min; zero retries | `e2e-final.log`. Skip: teste exclusivo do shell mobile não roda no projeto desktop. Quatro jornadas mobile antes puladas agora passaram. |
| Reteste de captura das chaves | **2/2**, 23,1 s | `e2e-artifacts.log`. Inspeção visual encontrou prefixo público quebrado fora da primeira caixa de máscara; captura agora oculta todos os glifos. Sem mudança de assertions ou comportamento da aplicação. |
| Newman 6.2.3 — HTTP | **19 requests / 49 assertions**, zero falhas | `newman.json/log`; Fastify real em loopback, serviços/provider sintéticos. |
| Newman — PERSISTENCE_RECEIPT_V1 | **19 requests / 49 assertions**, zero falhas | Mesmo contrato com opt-in. Não equivale a testar durabilidade do receptor; esta foi testada separadamente em PG/MinIO. |
| Newman mídia | **6 guards**, nenhum request indevido; **3 requests / 3 assertions**, zero falhas | Upload 201, consulta 200, admissão 202. `providerSends=0`; não houve mensagem real. |
| Bundle e fronteira pública | 32 arquivos, nenhum achado; contratos PASS | Verificadores locais existentes; não certificam imagem produtiva nem todo histórico de logs. |
| OpenAPI, Postman e PDF | Regenerados, testes contratuais incluídos na rodada ampla; PDF **8 páginas / 37 operações** | PDF renderizado e inspecionado; não foi publicado no Swagger produtivo. |
| Revisão final | Nenhum novo achado acionável após corrigir P2 de orientação; diff sem whitespace errors | Revisão independente de código, contratos, RBAC e assertions. Não substitui testes operacionais. |

## Reprodução e comandos

Executar a partir do checkout correto e com as dependências locais. Não executar comandos agregados sem conferir o escopo.

```powershell
node --max-old-space-size=256 node_modules/vitest/vitest.mjs run --exclude tests/backup.test.mjs --exclude tests/recovery.test.mjs --exclude tests/security-audit-artifacts.test.mjs --maxWorkers=1
node --max-old-space-size=256 node_modules/vitest/vitest.mjs run tests/repository-baseline.test.mjs apps/api/tests/unit/audit-corrections-readiness.test.ts apps/api/tests/unit/chatwoot-safe-http-socket.test.ts --maxWorkers=1
```

O segundo comando requer OpenSSL no PATH. No ambiente usado, foi o executável já instalado com Git, sem alteração de configuração global.

O pacote inclui `runners/run-receipt-lab.ps1`: valida label, banco e bind loopback do PostgreSQL exclusivo antes de montar URLs em memória. Stages executados: `pg`, `pg-regression`, `pg-replay`, `green-media`, `origin-critical`, `e2e-final`. MinIO privado deve estar disponível somente para o stage de mídia. Credenciais de laboratório não são exportadas no pacote. Os scripts não aceitam produção como fallback.

`runners/run-newman.mjs` usa Newman 6.2.3 do cache local, abre somente Fastify em 127.0.0.1 e encerra seus próprios processos. O arquivo de ambiente transitório não integra a entrega. `integrations/partner-qr/tests/lab2/run-binding-revocation.ps1 -SourceRoot <checkout-LAB2>` verifica hashes antes de carregar classes reais no Ruby isolado.

## O que não foi executado e por quê

- Backup, dump, restore, políticas e `ci:verify`: expressamente fora do escopo. Testes existentes preservados. `tests/backup.test.mjs` e `tests/recovery.test.mjs` não rodaram.
- `tests/security-audit-artifacts.test.mjs`: geração pesada da auditoria histórica excluída desta rodada por recursos. Verificações contratuais, bundle e revisões deste incremento rodaram; isso não é uma nova auditoria completa de imagem/logs.
- Toda a suite PostgreSQL do produto, teste de container/imagem final e rebuild completo da Evolution: não executados nesta rodada; selecionadas as regressões afetadas. Memória livre inicial de 397.600 KiB num host de 8 GB exigiu serialização. Nenhum container compartilhado foi encerrado.
- Rails completo, assets/jobs/TLS do LAB2 e RuboCop: stack isolada completa não disponível nesta rodada; somente a imagem Ruby reduzida e o checkout real foram usados.
- Servidor atual: controle da aba falhou com `browser.user is unavailable`; nenhuma consulta atual de banco, métricas, estado UNKNOWN ou sessão foi substituída por fotografia antiga.
- Sessões reais, Meta real, mídias reais, canários de logs da engine efetiva, carga de sessões e piloto 50/30 dias: dependem do ambiente e da autorização específica. Nenhum evento sintético foi contabilizado como número conectado.

## Integridade da prova

Não somar contagens de suites sobrepostas. Screenshots no pacote são de laboratório sintético, com chaves e identidade mascaradas; não são fotos do servidor. As evidências RED e as falhas de preparação foram mantidas junto dos GREEN. Registros históricos estão separados do incremento. Nenhuma obrigação foi apagada para fazer um contador ficar verde.
