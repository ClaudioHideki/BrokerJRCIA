# Mídia privada no worker — incremento local de 02/11/2026

## Implementação e prova executada

`labs/cclx-postgres-simulator/worker-integration.test.mjs` agora cobre quatro combinações: fonte interna ou S3 privada do Broker, com ACK HTTP ou `PERSISTENCE_RECEIPT_V1` no receptor sintético. O teste usa os módulos reais de worker, API key, HTTP, mídia e custódia do Broker, duas bases PostgreSQL descartáveis e MinIO real. O receptor é o laboratório; não representa uma instalação CCLX homologada.

Nos casos S3, o PUT real é persistido e seu recibo é deliberadamente perdido pelo adaptador de falha. PostgreSQL mantém a operação UNKNOWN e a mídia STORING. A reconstrução dos módulos recupera pela inspeção do objeto existente, sem outro download do provedor nem repetição cega do PUT. O teste verifica que o objeto guardado é cifrado, injeta indisponibilidade de leitura, exige retry e, depois, perde a resposta do receptor após o COMMIT do recibo. A repetição correlaciona o mesmo evento e recibo, mantendo uma única projeção. KEEP não produz intenção DELETE; o arquivo é lido fisicamente novamente e seu conteúdo decifrado confere.

Essa reconstrução de módulos não é um crash de processo, host ou sessão WhatsApp. A perda de resposta é uma falha injetada após a operação física; não constitui evidência de comportamento de todos os proxies ou redes produtivos.

## Resultado

- Primeiro run: **1 aprovado / 3 falhas**, todas as três em `CREATE DATABASE`, antes do percurso de mídia. `output/integral-private-media-worker-20261102.log`.
- Causa do harness: timeout apenas no cliente em cinco segundos podia abandonar a resposta enquanto PostgreSQL ainda executava a criação. O pool administrativo agora espera a resposta e usa cancelamento de DDL no servidor em 30 segundos. Isso não aumenta limites de consultas ou delivery produtivos.
- A limpeza de fixtures foi registrada antes da aquisição da segunda base, para não deixar a primeira aberta se a segunda falhar. Nenhuma base desconhecida ou compartilhada foi removida.
- Run final: **4 aprovados / 0 falhas / 0 skips**, duração **91.518 s**. `output/integral-private-media-worker-green-20261102.log`.
- API TypeScript compilou antes desse run, com `tsc -b apps/api/tsconfig.json` (exit 0). O resultado não aprova alterações de código concorrentes posteriores.

## Ambiente e encerramento

MinIO exclusivo `jrc-integral-media-minio-20261102`, loopback15440, rótulo `jrc.test.scope=integral-media-20261102`, limite256MiB/0.5CPU. Binário executado `/usr/bin/minio`: `RELEASE.2025-09-07T16-13-09Z`, SHA256 `7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f`. A imagem em cache carrega rótulos históricos diferentes; o binário foi conferido diretamente.

O container foi parado/removido após validar ID e rótulo. A imagem declarou um volume anônimo `/data`; a primeira tentativa de encerramento recusou a suposição incorreta de ausência de volumes. A segunda preservou esse volume, sem `-v`. Nenhum container ou bucket compartilhado foi alterado. Não foram executadas rotinas de backup, dump ou restore.

## Gates restantes

Falhas de host/controlador de armazenamento, crash do worker/origem no percurso completo, corpus real de codecs/tamanhos, consumidores Chatwoot reais, sessões WhatsApp e comportamento de retenção após aceite externo continuam com provas próprias. A suíte demonstra o contrato local de custódia e KEEP, não perda zero ou homologação operacional completa.

## Incremento posterior: processo receptor morto entre COMMIT e ACK

O caso fonte S3 privada + `PERSISTENCE_RECEIPT_V1` passou a executar o receptor em um processo Node separado (`receiver-process.mjs` e `receiver-process-child.mjs`). O proxy HTTP do laboratório só recebe seu resultado depois de persistência SQL, custódia física, readback e atestado. Antes de emitir esse ACK na rede, o teste encerra o processo filho e inicia outro PID com as mesmas referências PostgreSQL/MinIO. A promessa de reinício é aguardada explicitamente, inclusive se o cliente HTTP já tiver vencido seu timeout.

- **4/4 aprovados, 0 falhas/skips**, 82,110 s: `output/integral-media-process-crash-20261102.log`.
- Gate `RECEIVER_PROCESS_CRASH_AFTER_COMMIT_BEFORE_ACK`: PID 8544 encerrado, PID 1496 no receptor reiniciado. Node reportou `signal=SIGKILL`, `code=null` no host Windows. É encerramento real de processo; não representa entrega de sinal POSIX em Linux nem crash de host.
- O retry confirmou o mesmo recibo persistente; uma inbox, uma projeção e um recibo. Leitura independente dos bytes no MinIO conferiu; KEEP manteve a fonte privada cifrada e nenhuma operação DELETE foi criada.
- O IPC aceita somente operações fixas do laboratório. URLs/bases são restritas a loopback e fixtures marcadas. Tokens sintéticos trafegam somente em memória; stdout/stderr do filho não são encaminhados. Isso não é prova de sanitização de todos os componentes produtivos.
- Revisão independente encontrou corrida no reinício e limpeza sequencial interrompível; ambas foram corrigidas antes desse run. O cleanup tenta cada recurso, preserva a validação de ownership da base e relata erros sem limpar recursos compartilhados.
- API recompilada antes do run, exit 0. MinIO próprio `d42244dc3daa`, 256 MiB/0,5 CPU, usou tmpfs em `/data` e `/tmp`. Encerrado e removido após verificar ID/rótulo e ausência de mounts persistentes. O volume anônimo da execução anterior permanece preservado.

O PUT incerto na origem ainda é recuperado por reconstrução dos módulos, não por morte de processo de origem. O novo gate cobre precisamente a fronteira COMMIT do receptor → ACK perdido → processo novo → retry idempotente.
# Incremento posterior — crash físico da origem e do receptor

`output/integral-media-two-process-crash-20261102.log`: **8/8 GREEN, 90,919 s**, sendo quatro testes de fronteira do harness e quatro percursos do worker compilado com PostgreSQL e MinIO reais. Não somar os quatro percursos aos resultados anteriores sobrepostos.

No cenário fonte S3 + recibo persistente, o processo da origem foi encerrado após PUT confirmado e antes da liquidação SQL: PID24876; a recuperação ocorreu em outro processo, PID23824/exit0, após expiração natural da lease. O segundo processo leu estado durável e validou bytes, sem novo download do provedor nem novo PUT (totais1/1). O receptor também morreu após COMMIT e antes do ACK, PID19844→22832. Retry preservou IDs, um evento, uma projeção, um recibo e checksum; leitura independente confirmou retenção KEEP da origem e do destino.

Arquivos de harness: `media-source-process.mjs`, `media-source-process-child.mjs`, `media-source-process.test.mjs`, `worker-integration.test.mjs`. Executam somente com opt-in de laboratório, banco aleatório marcado, tenant sintético, storage loopback/bucket UUID e processo filho próprio. Ambiente herdado produtivo não é encaminhado. Revisão independente não encontrou bloqueador.

MinIO local limitado a256MiB/0,5CPU e tmpfs; binário RELEASE.2025-09-07T16-13-09Z com SHA256 `7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f`. Container `3c7c10c2cf2dc29748e83599117aab5b202f13b0e16ef9aa86227518922abc2c` removido após conferir ID/label; Mounts vazio, nenhum volume removido. Não acessou S3 produtivo.

Limites: processo encerrado via API Node no Windows não comprova sinais POSIX, crash do host, durabilidade física após queda de energia, sessão WhatsApp ou engine produtiva. KEEP continua obrigatório; recibo do parceiro não é prova automática da configuração física do storage remoto.
