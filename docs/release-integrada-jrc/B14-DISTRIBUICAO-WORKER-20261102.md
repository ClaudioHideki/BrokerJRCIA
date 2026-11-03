# B14 — distribuição do worker de eventos entre empresas

## Problemas reproduzidos

O comando `partner-events-worker` fazia até 20 chamadas sequenciais de uma empresa antes de visitar a próxima. Como cada chamada HTTP permite até 10 segundos, o receptor lento podia reter os vizinhos durante esse lote. A publicação dos eventos também ficava fora do `try/catch` por empresa: uma falha encerrava a execução inteira.

Regressão unitária RED: **4 falhas/2 passes**, `output/integral-partner-fairness-red.log`. Casos: ordem A/B, receptor lento, paginação de 101 tenants e falha na publicação. Os testes de orçamento de uma conexão e parada já passavam.

## Correção

- Uma chamada por empresa por rodada de descoberta completa, incluindo as páginas posteriores.
- No máximo 20 rodadas por ciclo, preservando o orçamento anterior de entregas por empresa.
- No máximo dois tenants em processamento simultâneo, nunca acima do `PARTNER_EVENTS_WORKER_DB_POOL_MAX` existente. Nenhum limite de pool/quotas/ENV foi aumentado.
- Uma empresa permanece sequencial nesta instância do worker. Locks, leases, idempotência, assinatura, retry/backoff e recibos do worker existente não foram substituídos.
- Erro de publicação ou processamento é isolado à empresa e registra somente código fixo, sem payload/credencial.
- SIGTERM/SIGINT interrompem novas admissões; operações admitidas drenam antes de fechar o pool.
- Retenção existente continua sendo visitada, inclusive para empresas suspensas; entrega mantém o gate de empresa ativa.

GREEN unitário com regressão dos pools: **44/44, dois arquivos, 4,53s, exit0**, `output/integral-partner-fairness-green.log`. Revisão independente não encontrou bloqueante.

## Gate PostgreSQL executado

`apps/api/tests/integration/partner-worker-fairness.test.ts`: **1/1 GREEN, 10,02s, exit0**, `output/integral-partner-fairness-postgres-green.log`. PostgreSQL real, dois tenants, worker/comando reais e transporte sintético controlado. O tenant saudável foi atendido enquanto o outro aguardava; SIGTERM preservou três pendências. Após perda de ACK, somente o mesmo event/delivery ID foi repetido: cinco chamadas, quatro IDs únicos e quatro DELIVERED com tentativas `[1,1,1,2]`. O receptor desse teste é uma porta sintética em memória; não é evidência de HTTP remoto ou perda de host. Não manipula operações de mensagem UNKNOWN.

A página seguinte ainda aguarda a operação lenta restante da página atual; a correção reduz o bloqueio e compartilha as duas vagas, mas não garante latência independente entre páginas ou tenants ilimitados. Novos testes de carga do worker completo continuam necessários para capacidade de 50/400/900 sessões. Não houve deployment, replay de histórico, envio real ou alteração produtiva.
