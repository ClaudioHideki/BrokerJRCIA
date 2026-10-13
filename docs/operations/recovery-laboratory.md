# Recuperação de mídia privada em laboratório

O CLI captura, autentica e restaura um banco efêmero PostgreSQL, um namespace Redis e os objetos privados referenciados pelo ledger. A configuração privada, o dump, o snapshot Redis e os bytes ficam cifrados; o manifesto público tem HMAC e cada artefato tem AES-GCM. A chave de backup fica fora do backup.

Este corte cobre o ensaio isolado de recuperação, com limites de 64 MiB, 32 objetos e 128 keys. Ele não é o backup integral do servidor, das sessões Evolution, das roles de um cluster vazio ou do RDB/AOF global. Dimensionamento produtivo, janela consistente, TLS e RPO/RTO são critérios adicionais do programa C5.

## Executar

Configure `JRC_BACKUP_KEY` no ambiente privado do operador, com 32 bytes codificados em base64. Guarde URLs, credenciais, caminhos e configuração num arquivo de parâmetros privado, fora do Git. O CLI não imprime esse arquivo nem os detalhes de conexão.

```sh
node scripts/operations/recovery/recovery-cli.mjs capture --parameters /caminho/privado/capture.json
node scripts/operations/recovery/recovery-cli.mjs verify --parameters /caminho/privado/verify.json
node scripts/operations/recovery/recovery-cli.mjs restore --parameters /caminho/privado/restore.json
```

`verify` funciona sem conectar aos serviços. Capture/restore usam o módulo compilado `apps/api/dist/modules/messaging/private-object-store.js`, configurado explicitamente em `objectStoreModule`. Esses scripts acompanham a fonte Git; não são apresentados como comandos já instalados no container de produção.

Os parâmetros incluem `directory`, `databaseUrl`, `targetDatabaseUrl`, `redisUrl`, `redisNamespace`, executáveis `pgDumpExecutable`/`pgRestoreExecutable`, `privateConfigurationFile`, `objectStoreModule`, `restoreJournalPath`, `backendFingerprint`, `metadata` e `quiescence`. A metadata conserva SHA observado, digests efetivos ou a condição explícita de fonte ainda não publicada, baseline e versões dos serviços.

O alvo PostgreSQL deve estar vazio, em loopback, com nome `jrc_test_<pid>_<uuid>`. O namespace Redis é exclusivo `broker-c5-*:`; o bucket MinIO é dedicado `broker-c5-*`, de laboratório em loopback. O CLI exige versões e fingerprint iguais aos do backup. Não aceita DROP, `--clean`, FLUSH, REPLACE ou alteração dos ledgers para apontar a outro destino.

Capture exige declarar PostgreSQL, Redis, object store e provedores pausados. Essa declaração não pausa os serviços nem prova a pausa. Em laboratório, a exclusividade vem da propriedade dos recursos sintéticos. O hash do ledger antes/depois detecta alterações, mas não substitui uma janela consistente entre sistemas.

Restore verifica todos os artefatos antes de efeitos. Observa objetos existentes; conteúdo igual dispensa PUT. Objeto ausente com bytes autenticados recebe intenção administrativa persistida antes de um PUT. Resultado incerto autoriza somente observação/reconciliação, sem repetição cega. Um PUT/DELETE UNKNOWN do runtime permanece UNKNOWN quando a observação não o resolve.

Não apague o journal cifrado para repetir uma operação. `restore.lock` protege um operador por diretório; um lock remanescente exige confirmar que o processo anterior terminou. Falha após restaurar PostgreSQL exige diagnóstico e outro banco vazio para um novo ensaio integral.

TTL Redis persistente permanece persistente; keys ausentes/expiradas não são recriadas. TTL positiva conserva o prazo absoluto e não é ampliada por relógio atrasado ou espera na restauração. Depois do restore, confira ledger, bytes, leitura autorizada, isolamento de outra empresa e reconciliação antes de permitir tráfego.

## Testes reproduzíveis

Os contratos do formato fazem parte de `npm test`. O ensaio físico separado requer build e parâmetros explícitos:

- `TEST_DATABASE_ADMIN_URL` e `TEST_REDIS_URL` para os serviços locais de laboratório.
- As oito variáveis `TEST_STORAGE_*` exigidas pelo gate de armazenamento, incluindo release e hash fixados do MinIO.
- `TEST_RECOVERY_PG_DUMP_EXECUTABLE` e `TEST_RECOVERY_PG_RESTORE_EXECUTABLE` para os binários confiáveis da mesma família PostgreSQL.

```sh
node node_modules/vitest/vitest.mjs run --config vitest.recovery.config.ts
```

O teste cria banco, namespace e bucket próprios, faz capture/restore pelo CLI real e usa o core canônico. A prova original na baseline 0052 passou 15 contratos e quatro cenários físicos. Em 13/10, o corte portátil passou cinco testes físicos: os quatro cenários de recuperação e um cenário adicional de relógio Redis. Também passaram o novo teste do orçamento agregado de 64 MiB e os três contratos afetados do CLI. O limite considera dump, Redis, configuração, ledger e objetos em conjunto, antes de publicar um manifesto de sucesso.

As evidências incluem bytes privados legíveis, negativa a outro tenant, conservação de UNKNOWN e zero reenfileiramento de mensagens. Isso não comprova entrega no WhatsApp ou recuperação da infraestrutura produtiva.
