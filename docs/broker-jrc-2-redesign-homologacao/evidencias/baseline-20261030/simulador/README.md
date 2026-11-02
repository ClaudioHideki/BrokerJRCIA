# Simulador CCLX local — reconciliação de 30/10/2026

Pacote executável com Node 24.19.0 e módulos nativos. Reaproveita o receptor de `docs/auditoria-900/lab`, sem alterar o Broker nem o Engine. O receptor e seu banco são reais e locais: SQLite WAL/FULL, arquivo de mídia com `sync()` e recibo após commit. O conteúdo e o comportamento de CCLX continuam sintéticos.

Executar nesta pasta, com Node24 disponível no PATH. Os mesmos comandos funcionam no PowerShell/Windows e em bash/Linux; a validação desta entrega ocorreu no Windows com Node24.19.0, sem prova de execução Linux:

```powershell
node run-safe-tests.mjs --lab-only
node scenario.mjs --lab-only --smoke
node scenario.mjs --lab-only --plan
```

O primeiro roda os testes com ambiente reduzido e caminhos fixos. O segundo envia somente oito eventos em loopback, injeta ACK perdido, reabre o banco, grava uma fixture de mídia e verifica leitura/hash após reinício. Remove apenas o temporário que criou. O terceiro imprime o plano 50/100/200/400 e preparação para 900, sem executar carga. Não há opção de URL externa, provider ou benchmark. A CLI recusa opções desconhecidas e `NODE_ENV=production`. Nenhum comando lê `.env`, instala pacotes ou cria serviços.

Para abrir manualmente somente o receptor e manter seu estado temporário até inspeção:

```powershell
node cclx-receiver.mjs --lab-only
```

A rota é exclusivamente `POST http://127.0.0.1:<porta-efêmera>/lab/cclx/events`. Não é uma rota do Broker ou do CCLX. A API local `persistMedia` aceita apenas chunks Buffer, IDs reservados, hash esperado e MIME de fixture; não recebe URL/caminho arbitrário. Não apontar o worker produtivo para esta CLI. O worker real recusa loopback por segurança; a futura integração local deve usar a injeção de transporte já existente no harness.

## Contrato e estados

- HMAC-SHA256 sobre `timestamp.eventId.corpoBruto`; headers `X-JRC-Event-Id`, `X-JRC-Timestamp`, `X-JRC-Signature`. Segredo público exclusivamente sintético. Janela receptora de ±300 s.
- Tenants reservados terminados em `0900` e `0910`; IDs de evento `00000000-0000-4000-8000-` seguidos de 12 dígitos. O namespace comporta 250 mil IDs, mas não foram enviados 250 mil eventos.
- Cursor string decimal canônica até `9223372036854775807`; corpo limitado a 2 MiB; somente `message.received` e `data:{labFixture:true,sequence:inteiro}`. Um futuro adaptador de contrato real precisa de schemas próprios; não basta liberar JSON arbitrário.
- Inbox unique por tenant/eventId + hash e envelope, projeção sintética na mesma transação; 202 somente após COMMIT. Duplicado com mesmo corpo não cria efeito; corpo divergente retorna 409.
- `persistMedia` exige inbox já persistida, grava temporário privado, calcula hash/tamanho, verifica assinatura MIME superficial, sincroniza arquivo, publica nome gerado por hash e grava recibo em SQLite. Só depois retorna `ACK_COPY_PERSISTED_LAB`/`COPY_PERSISTED_UNVALIDATED`. Esse recibo é uma convenção interna do laboratório. O Broker já possui `POST /v1/media-custody/receipts` para atestação declarada pelo cliente, mas o smoke não chama essa rota; a consulta de retenção retorna KEEP, eligibleForDeletion=false e physicalStorageVerified=false. O recibo existente não comprova o storage físico do cliente nem autoriza expurgo.
- Interrupção/hash errado/limite não geram recibo. Falha após sync e antes do recibo deixa objeto órfão verificável para retry. ACK perdido depois do commit recupera o mesmo recibo. A fila de gravação de mídia é serial neste simulador.
- `sourceEligibleForDeletion` permanece false. Hash e assinatura MIME não provam codec nem arquivo renderizável. A fixture WAV é do laboratório; não implica suporte WAV na API pública do Broker.

O banco tem `application_id` marcado e `user_version=3`; diretórios temporários de versões anteriores são recusados, sem migrar nem sobrescrever dados. Testes antigos de idempotência, autenticação, crash de processo e mídia em memória foram preservados. Os novos testes cobrem dois tenants, cursor BIGINT, mídia em arquivo e ACK do recibo perdido após commit.

## Limites de evidência

Não foram homologados PostgreSQL, S3/MinIO, Redis, CCLX real, sockets Evolution ou WhatsApp. O teste herdado mata abruptamente o processo receptor após commit de evento. A mídia persistida é verificada após close/reopen; ainda falta teste de kill abrupto durante publicação do arquivo/recibo, perda elétrica/disco e restore conjunto DB+objeto. `fsync` do arquivo e WAL/FULL não comprovam sincronização do diretório em todas as plataformas, replicação ou backup. O estado no TEMP é descartável.

O README e a API sintética descrevem o limite com precisão: persistência local real, projeção sintética, mídia copiada não validada como arquivo utilizável e nenhuma escala de carga validada. O plano de complementação está em `../simulator-benchmark.md`.
