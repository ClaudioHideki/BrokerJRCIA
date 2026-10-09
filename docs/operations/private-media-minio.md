# Mídia privada por MinIO — C2

Esta etapa acrescenta o backend privado de objetos e a migração `0052_durable_private_media`. A imagem deve ser publicada a partir da `main` e ter CI e imagens aprovados no mesmo SHA antes da instalação. O backend padrão continua `postgres`; o deploy não cria um servidor MinIO nem transfere a mídia histórica automaticamente.

## Configuração

Para conservar a operação atual, mantenha `MEDIA_STORAGE_DRIVER=postgres` e os campos `MEDIA_S3_*` vazios. Depois de preparar o armazenamento, configure o perfil completo no ENV privado do Dokploy:

```dotenv
MEDIA_STORAGE_DRIVER=s3
MEDIA_S3_ENDPOINT=https://SEU_ENDPOINT_MINIO
MEDIA_S3_BUCKET=broker-media
MEDIA_S3_PROFILE=broker-media-v1
MEDIA_S3_REGION=us-east-1
MEDIA_S3_ACCESS_KEY_ID=CONFIGURAR_NO_SERVIDOR
MEDIA_S3_SECRET_ACCESS_KEY=CONFIGURAR_NO_SERVIDOR
MEDIA_S3_DEDICATED_BUCKET=true
MEDIA_S3_REQUEST_TIMEOUT_MS=30000
```

O servidor real validado no laboratório é MinIO `RELEASE.2025-09-07T16-13-09Z`, acessado por HTTP loopback exclusivo de teste. Em produção o adaptador exige HTTPS; o caminho TLS do servidor ainda precisa ser homologado. O perfil usa assinatura SigV4, endereçamento path-style e operações de objeto individuais. Ele exige PUT condicional `If-None-Match: *`: uma colisão responde 412 e conserva os bytes originais. Compatibilidade com outro servidor S3 precisa ser demonstrada pelos mesmos contratos. O bucket precisa ser dedicado e privado, sem política de bucket, sem histórico de versionamento e sem Object Lock. A credencial precisa permitir consultar versionamento, política, Object Lock e ACL, além de ler, gravar e excluir os objetos desse bucket. O adaptador confirma essas condições em cada operação. Não habilite acesso anônimo ou URLs públicas permanentes.

O Compose encaminha os campos apenas para API, worker de mensagens e worker de lifecycle. Ele não instala MinIO nem altera a Evolution. `MEDIA_STORAGE_BYTES_PER_ORGANIZATION` continua limitando a soma da mídia histórica inline e das reservas/objetos privados da empresa.

Preserve endpoint, bucket, região, perfil e `INTEGRATION_ENCRYPTION_KEY` enquanto existirem objetos que os referenciam. A identidade do destino é conferida na leitura e na exclusão; trocar o bucket não migra os dados. Credenciais de acesso podem ser rotacionadas mantendo o mesmo destino e permissões. Este corte opera um perfil ativo, sem gerenciador de migração entre buckets.

## Instalação no Dokploy

Use os digests de API e WEB da mesma release aprovada na `main`. Preserve stack, volumes, senhas, chaves e domínio. Antes da manutenção, produza backup recuperável e pare os consumidores da aplicação; a conexão PostgreSQL existente precisa permanecer disponível.

Para a stack já utilizada, em **Advanced → Run Command**, salve o comando temporário abaixo. O campo já acrescenta `docker`, portanto começa por `compose`:

```text
compose -p jrc-broker-broker-ophydn -f ./infra/dokploy/compose.yaml --profile maintenance run --rm --no-deps migrate
```

Execute **General → Deploy** e confirme saída sem erro e `Schema and dedicated roles provisioned.`. O migrador não imprime os nomes de cada migração: confirme a baseline 0052 separadamente após iniciar a nova API. Em outra instalação, use o nome real do projeto Compose. O procedimento completo está em [release do produto](release-broker-product-20260929.md).

Em seguida, apague todo o **Run Command**, salve e execute **General → Deploy** novamente. Essa segunda execução inicia API, WEB, sandbox e workers com a nova release. Não deixe o comando de migração configurado como deploy normal. Não use `down -v`.

Confira imagens efetivas, readiness, baseline `0052_durable_private_media`, estrutura compatível e saúde dos workers. No **Open Terminal** do container API, o diagnóstico de leitura é:

```sh
node /app/apps/api/dist/commands/operational-status.js
```

O relatório precisa apresentar `schema.baseline` igual a `0052_durable_private_media` e `schema.compatible` igual a `true`, além dos checks locais de banco, flag e readiness. A identidade da imagem e o recibo/journal da migração são evidências complementares. O deploy com `postgres` também requer 0052. Para ativar MinIO posteriormente, configure o perfil completo e recrie os serviços pelo deploy normal. Depois de gravar objetos privados, conserve o backend S3 e o destino necessários para leitura e limpeza desses objetos; voltar a `postgres` não os converte em mídia inline.

## Comportamento e aceite

A mídia histórica `INLINE_V1` permanece legível. Mídia nova no perfil S3 reserva quota, conserva uma operação durável e só fica disponível após confirmação do objeto e de sua integridade. Os metadados permanecem no PostgreSQL; o staging cifrado existe enquanto a gravação está pendente. Leituras passam pela autorização da empresa e do canal.

Um resultado remoto incerto conserva `UNKNOWN` para reconciliação por leitura, sem repetir a gravação cegamente. A exclusão usa a role e o lease de lifecycle; ausência remota precisa ser observada antes de finalizar o purge. O botão de retry de um job da central não reinicia um upload privado rejeitado como se fosse mídia inline.

Após instalar, homologar texto e mídia nos dois sentidos, download autorizado, negativa para outra empresa, reinício com operação pendente e exclusão controlada de dados sintéticos. Readiness e testes locais não comprovam esses resultados no servidor.

O backup precisa conservar banco, objetos privados e chaves da mesma janela. O utilitário de backup anterior não coleta este bucket automaticamente. A automação de backup/restauração de objetos e o ensaio integrado pertencem ao incremento C5; até sua conclusão, registre o procedimento operacional do bucket e teste a restauração isolada.
