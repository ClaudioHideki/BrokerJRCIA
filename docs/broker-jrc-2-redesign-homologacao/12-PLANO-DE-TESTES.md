# Plano de testes funcionais — Broker 2

Objetivo: demonstrar comportamento útil e integridade, com prova por fronteira. Build/typecheck/HTTP200 são gates auxiliares.

## Evidência executada nesta frente

Comando no checkout d1b66a:

```text
node node_modules/vitest/vitest.mjs run apps/api/tests/unit/chatwoot-health.test.ts apps/api/tests/unit/chatwoot-control-auth.test.ts apps/web/src/integrations/ConnectionHealthSummary.test.tsx --maxWorkers=1
```

Resultado:3 arquivos/6 testes aprovados, exit0,10,56s. São booleanos de transporte, autorização e UI jsdom; não exercitam a consulta SQL de status ou uma jornada real. Nenhum teste PG/Redis/S3 novo foi executado aqui.

## Piloto H01: reproduzir antes de corrigir

| Caso | Preparação sintética | Aceite |
|---|---|---|
| Falha antiga superada | FAILED anterior e sucesso posterior no mesmo domínio | Saúde atual segue política explícita; histórico preservado |
| Resultado incerto antigo | UNKNOWN sem prova de reconciliação, inclusive anterior a24h | Continua visível/degradado; zero replay |
| Falha presente | Falha posterior ao sucesso | DEGRADED |
| Sem prova bilateral | Conexão/callback válidos, sem inbound ou outbound recente | UNVERIFIED |
| Troca de credencial/destino | Callback da revisão anterior | Callback não sustenta OPERATIONAL |
| Identidade divergente | Fingerprint observado diferente do aprovado | Não operacional; confirmação explícita |
| Estado muda durante I/O | Mapping READY→DISABLED entre leituras | Resultado usa mapping atual |
| Acesso revogado | Revalidação final nega scope/tenant |403/404 contratual; nenhum dado de outro tenant |
| Consulta de status | Chamar status em vários estados | Zero pair/disconnect/send/replay; observações técnicas permitidas |

Usar `createChatwootControlService` com interfaces existentes. O teste deve observar retorno e chamadas de efeitos; não apenas procurar texto no fonte. Se extrair função pura, manter teste de service para provar wiring. Depois ampliar `apps/api/tests/integration/chatwoot-control-health.test.ts` com PG real para SQL e concorrência.

## Jornadas prioritárias

| Jornada | Camadas exigidas | Evidência de saída |
|---|---|---|
| Operador identifica conexão sem transporte | API real+UI autenticada | Estado coerente, motivo e ação permitida; sem falso sucesso |
| Grupo fora de escopo | Ingress→admissão→worker→UI | Zero envio e ausência de avalanche de FAILED; justificativa auditável |
| Mensagem única com ACK perdido | Outbox+receptor persistente | Um efeito por intenção, retry rastreável |
| UNKNOWN de envio | Worker+ledger+reconciliador | Nenhum envio novo sem prova de resultado |
| Replay parceiro | API+PG+worker+receptor | Mesmo eventId e ledger; um efeito, sem envio WhatsApp |
| Custódia de mídia | Download autenticado+objeto privado+receipt | Hash/tamanho iguais, retry idempotente, KEEP e zero exclusão |
| Tenant adversarial | API+SQL/RLS+storage | Negação de leitura/escrita cruzada inclusive durante revogação |
| Recuperação | DB+objetos+checkpoint+workers | IDs aceitos reconciliados, hashes íntegros, efeitos não duplicados |

## Laboratório seguro e execução

O helper PG `apps/api/tests/integration/helpers/postgres.ts` cria/deleta bancos e migrations podem tocar roles; TEST_DATABASE_ADMIN_URL sozinha não prova isolamento. Exigir cluster dedicado, marcador de laboratório, URLs próprias, credenciais de fixture e sem reachability produtiva. S3/MinIO deve usar bucket próprio privado; Redis namespace/instância descartável.

Após esse preflight, reaproveitar suites integration de chatwoot-control-health, partner-events, partner-delivery-replay, media-custody, qr-chatwoot-storage; storage/private-media-minio e recovery.lab. O Docker respondeu em consulta elevada; a preparação e execução do laboratório continuam PENDENTES, não marcar SKIP como PASS. Não rodar migrations ou restore em servidor compartilhado.

Browser: validar perfis empresa/admin/delegado e tenant adversarial; capturas com estado e motivo, requests sanitizados e confirmação do efeito persistido. Teste visual de componente não substitui navegação/autenticação real.

## Critério de encerramento

Registrar SHA, comando, ambiente, duração, resultado, negativos, falhas injetadas e artefatos. Zero perda/efeito duplicado/escape tenant. Para cada falha real guardar erro canônico e correlação sem conteúdo. Não somar suites sobrepostas ou afirmar cobertura operacional a partir de testes mocks. Regressões da alteração devem passar; PG/E2E pendentes continuam visíveis na entrega.
