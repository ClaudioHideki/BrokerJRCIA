# Incremento local — origem, custódia e operação

Continuação da PR #6, revisão de partida `ea58a897b923fc5889e99ea039b4bd61c385d781`, na mesma branch `codex/broker-jrc-2-redesign-homologacao-20261030`. Este documento substitui as afirmações temporais anteriores sobre os componentes aqui descritos. Não substitui evidência de implantação ou de sessão real.

## Fronteira da execução

Código e testes locais com dados sintéticos. Nenhum deploy, merge, alteração de credencial, envio, pareamento, replay de operação real ou migração produtiva. Arquivos anteriores e o submódulo Evolution foram preservados. Os resultados da CI e imagens de ea58 não cobrem este novo diff; consultar `ESTADO-FINAL.json` e o relatório de verificação deste incremento.

## 1. Recibo do Broker após persistência

Arquivos principais: `apps/api/src/modules/messaging/origin-receipt.ts`, `qr-service.ts`, `apps/api/src/http/routes/integrations.ts`, migration `0078_qr_origin_receipts.sql`, schema e gates de prontidão.

Problema: o ACK legado `{status:"accepted"}` não correlaciona a obrigação durável de origem. Transformar qualquer HTTP 200 em recibo permitiria apagar uma obrigação não comprovada.

Correção: extensão opcional da rota existente `POST /v1/webhooks/whatsapp/{id}`. A autenticação Bearer por canal/frota permanece. Os headers `x-jrc-origin-event-id` e `x-jrc-origin-content-sha256` devem vir juntos; o hash cobre os bytes JSON exatos. A primeira versão admite somente a projeção estrita de um texto individual. Fatos não suportados não recebem ACK de custódia.

O serviço persiste mensagem/observação, efeitos transacionais existentes e recibo com `synchronous_commit=on`. Só após COMMIT retorna `sourceEventId`, `durablyAccepted:true` e `accepted` ou `duplicate`. Reutilizar identidade com conteúdo ou vínculo diferente gera conflito. O recibo não significa envio, entrega ou leitura no WhatsApp.

Revisão detectou que um UUID novo com o mesmo ID do provider poderia ser aceito enquanto a deduplicação antiga preservava outro conteúdo. O serviço agora confere direção, contato, texto e horário do fato retido antes do ACK. Outra regressão demonstrou deadlock ao promover locks compartilhados: o caminho opt-in adquire o lock do canal na ordem existente instância → canal antes de inserir recibo.

O ledger possui RLS forçada, chaves compostas de tenant/canal/instância, SELECT/INSERT somente para a aplicação, ausência de payload/chave/telefone e participação no ciclo de exclusão existente. O readiness foi estendido para verificar PK imediata, índice válido e pronto, FKs exatas, grants, policies e triggers. Desvio estrutural deve impedir prontidão, não esperar a primeira falha no webhook.

Compatibilidade: clientes legados continuam com a resposta anterior, sem headers obrigatórios novos. A documentação agora inclui uma rota que já existia e sua autenticação própria; não é uma nova API de parceiro. O guia público continua limitado às operações públicas de parceiro.

## 2. Transporte e falha de processo na origem

Arquivos: `integrations/evolution-origin-journal/src/{http-transport,worker,bootstrap,webhook-ownership,webhook-overlay}.mjs`, extensão do journal e testes correspondentes.

Implementados transporte HTTPS vinculado a um canal, Bearer, UUID estável, hash de bytes, validação estrita do ACK, limites de tamanho/prazo e retry limitado. O worker é serial e finito, com cancelamento cooperativo. Construir o bootstrap não inicia processamento nem registra o componente na engine.

Testes encerram processos Node filhos de verdade após COMMIT da captura, após COMMIT do claim e após COMMIT do destinatário antes do ACK. Um teste usa a rota e o serviço reais compilados do Broker, HTTP local e PostgreSQL real; a recuperação após expiração de lease mantém um único fato e recibo. Isso não é crash da engine Evolution, do host ou do PostgreSQL.

O guard de webhook verifica prova visível de COMMIT, identidade, conteúdo e binding; booleanos não são prova. O overlay é preparado em memória sobre o arquivo upstream com hash fixado, sem modificar o vendor. A decisão é por destino local/global e preserva os outros transportes da engine. Erro de um guard não pode abortar os destinos independentes nem reenviar pelo caminho legado do destino protegido. Os diagnósticos desse caminho são códigos estáticos, sem corpo/URL/erro sensível.

Bloqueio interno restante: o processamento upstream perde a origem notify/append antes do controller. Ainda falta transportar essa proveniência e instalar captura, autoridade, pool limitado, chave recuperável, worker e guard juntos antes de habilitar eventos. `deliveryOwnership:'UNPROVEN'` continua bloqueando a ativação. Não habilitar em uma engine real com base nestes testes.

## 3. Custódia em MinIO real

Arquivos: `labs/cclx-postgres-simulator/{receiver,s3-custody,media-s3.test}.mjs`.

O receptor de laboratório usa o adaptador S3 já existente: PUT condicional, bucket privado descartável, leitura de retorno e SHA-256 antes do recibo SQL. Falha após upload conserva objeto órfão; retry adota os bytes verificados. Perda da resposta após COMMIT devolve o mesmo recibo. Corrupção, conteúdo diferente, endpoint não local ou destino divergente são recusados.

Revisão reproduziu disputa entre receptor filesystem e receptor S3: o perdedor podia devolver recibo do modo errado. A validação final de modo/destino agora é simétrica e possui regressão com concorrência PostgreSQL real.

Retenção permanece KEEP e `sourceEligibleForDeletion:false`. ACK do evento não é recibo da mídia. Os bytes sintéticos deste receptor não são cifrados por ele; a extensão `.cipher` usada no key do adaptador não prova criptografia. Leitura por hash prova disponibilidade naquele momento, não durabilidade física futura ou restauração. Faltam produtor/worker integrado, inventário de órfãos, backup/restore de objetos e custódia das chaves.

Foi identificado um detalhe relevante da infraestrutura de teste: o PATH da imagem MinIO em cache selecionava binário antigo. A execução fixou explicitamente `/usr/bin/minio`, verificando versão e SHA-256. Nenhum MinIO compartilhado ou bucket produtivo foi alterado.

## 4. Contrato do consumidor LAB2

Arquivos: `integrations/partner-qr/tests/lab2/`, configuração específica e `LAB2-CONSUMER-EVIDENCE.md`.

As respostas da rota Fastify são submetidas à classe Ruby real `JrcBroker::Response` do LAB2, sem modificá-la. Seu blob foi confrontado com o repositório conectado. O container Ruby temporário não possui rede, recebe somente dois arquivos de leitura e usa dados sintéticos.

São verificados vínculo/inbox, status conectado sem inventar entrega, operação pendente e UNKNOWN sem novo comando, expiração e identidade de QR/operação e filtragem de diagnósticos. A facade/autorização do Broker nesta prova é fixture; não é sessão Rails completa. A suíte genérica de parceiro continua separada.

Falta homologar o host Rails completo: migrations/DB, sessão/CSRF, grants e revogação, cliente TLS, credencial cifrada, Redis/PubSub, navegador, entrada/saída/mídia e recuperação. Isso é uma pendência interna de ambiente e integração JRC, não depende exclusivamente do CCLX.

## 5. Painéis e orçamento

Os shells administrativo e da empresa receberam navegação responsiva, identificação do contexto/perfil em tela estreita, breadcrumb, atalho para o conteúdo, fechamento por Escape/backdrop, contenção de foco e retorno ao acionador. Rotas, RBAC e contratos foram preservados. Há testes de navegação e cenários Chromium em 320, 390 e 1280 pixels. Isso não homologa todos os módulos nem substitui teste com leitor de tela.

`labs/capacity-pool-budget/` exige inventário explícito dos perfis de pool por processo, inclusive réplicas desativadas, reserva administrativa e sobreposição no rollout. Um processo web precisa contar app/auth e a escolha explícita de plataforma; não pode ocultar orçamento ao medir só o pool app. Não altera limites nem configura produção. O gate entrou em CI e no workflow de imagens.

Os dashboards de saúde e a proteção de polling já presentes em ea58 foram preservados. Não houve limpeza de FAILED/UNKNOWN nem nova autorização implícita para reenvio.

## Migration e rollback

0078 é aditiva e foi aplicada somente nos bancos descartáveis. O schema separado do journal de origem pertence ao componente da engine e não é migration do Broker. Não executar DDL de engine no banco Broker como atalho.

Para uma futura implantação, primeiro validar restore, migration e compatibilidade na homologação. Se for preciso voltar o binário, manter os ledgers e dados, interromper a nova captura/worker de forma controlada e preservar obrigações ainda não reconhecidas. Um Broker legado retorna ACK sem correlação; o novo dispatcher deve mantê-lo incerto, nunca promover a sucesso. Não fornecer rollback destrutivo que apague recibos ou journal. Após primeira admissão, remoção de tabelas exige migração de dados e revisão própria.

## Próxima ordem de execução

1. Instalar composição da engine em cópia de build fixada, com proveniência e exclusividade verificáveis; compilar e ensaiar crash/restart do binário real.
2. Concluir pipeline de mídia com produtor/worker e restore conjunto de SQL, objetos e chaves; manter KEEP até aceite.
3. Provisionar LAB2 isolado na versão reconciliada e executar os fluxos completos de autorização, mensagens, mídia, reconexão e revogação.
4. Revisar logs/canários na imagem efetiva, fairness multi-tenant e orçamento medido dos pools.
5. Executar benchmark progressivo e só então avaliar piloto real autorizado. Não declarar 50/400/900 aptos pelo número de eventos sintéticos.
