# Release do incremento Broker — roteiro Dokploy

Este roteiro aplica o incremento descrito em [Execução do plano de produto](../implementation/broker-product-20260929.md). É um procedimento para a release aprovada, não um registro de deploy concluído. Ao escrever este documento, não havia comprovação da promoção do incremento para `main`, de CI remota concluída ou dos novos digests publicados.

## 1. Confirmar a release antes de trocar o ENV

Registrar o commit aprovado que contém as migrações `0032_lifecycle_deletion.sql` e `0033_support_tickets.sql`, o serviço `lifecycle-worker` e a disponibilidade do Flow. Confirmar esse commit na `main` e o sucesso dos gates de release. Gerar e publicar as imagens API e WEB no GHCR a partir desse mesmo commit.

Copiar os digests reais dos artefatos publicados. Não usar o digest antigo por conveniência e não substituir por um valor inventado ou `latest`. A `main` fornece o Compose; `JRC_API_IMAGE` e `JRC_WEB_IMAGE` determinam o código dentro dos containers. Alterar só a branch ou clicar Deploy com digests antigos não atualiza esse código.

Em **JRC Broker → production → broker → General**, manter:

| Campo | Valor |
|---|---|
| Provider | Git |
| Repository URL | `https://github.com/ClaudioHideki/BrokerJRCIA.git` |
| Branch | `main` |
| Compose Path | `./infra/dokploy/compose.yaml` |
| Projeto Compose existente | `jrc-broker-broker-ophydn` |

Desabilitar **Autodeploy** durante a manutenção manual para impedir que outro deploy execute o comando temporário. Preservar o nome do projeto e os volumes existentes. Esta atualização não exige apagar o banco ou recriar volumes.

## 2. Preparar o Environment

Em **Environment**, manter as credenciais existentes e `PUBLIC_ORIGIN=https://jrc-broker.jrcws.cloud`. Adicionar uma senha independente para a nova role:

```dotenv
JRC_LIFECYCLE_PASSWORD=<SENHA_ALEATORIA_EXCLUSIVA_HEXADECIMAL_COM_PELO_MENOS_32_CARACTERES>
LIFECYCLE_WORKER_INTERVAL_MS=3000
SUPPORT_RESPONSE_HOURS=24
PUBLIC_INGRESS_IP_LIMIT_PER_MINUTE=6000
PUBLIC_INGRESS_RESOURCE_LIMIT_PER_MINUTE=6000
AUTOMATION_RUNTIME_V2_ENABLED=false
```

O texto entre `<...>` é um marcador: substituí-lo antes de salvar. É possível gerar 32 bytes aleatórios, resultando em 64 caracteres hexadecimais, no terminal de um container Node do Broker:

```sh
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

Copiar o resultado apenas para `JRC_LIFECYCLE_PASSWORD` no ENV privado; não anexar a saída ao Git nem ao relatório. A senha deve ter pelo menos 32 caracteres; hexadecimal evita escape especial na URL PostgreSQL. Não reutilizar `POSTGRES_PASSWORD` ou outra chave.

Atualizar as duas imagens com os digests verificados da release. Estes marcadores não são valores válidos de imagem:

```dotenv
JRC_API_IMAGE=ghcr.io/claudiohideki/brokerjrcia-api@sha256:<DIGEST_API_DA_RELEASE>
JRC_WEB_IMAGE=ghcr.io/claudiohideki/brokerjrcia-web@sha256:<DIGEST_WEB_DO_MESMO_COMMIT>
```

Preservar a imagem Evolution já aprovada, senhas de banco, chaves de cifra e credenciais da central. O worker de exclusão reutiliza a origem interna e a chave Evolution desse stack. Não preencher `LIFECYCLE_DATABASE_URL` manualmente: o Compose constrói a URL com usuário `jrc_lifecycle` e a nova senha.

Salvar o ENV. `JRC_LIFECYCLE_PASSWORD` é obrigatória mesmo na execução isolada da migração, pois o Compose valida as variáveis do arquivo. Meta continua exigindo onboarding e credenciais próprias; esta release não as gera.

## 3. Executar as migrações pelo serviço no Dokploy

Confirmar em **Containers** que o PostgreSQL existente está `healthy`. Em **Advanced → Run Command**, inserir exatamente o comando abaixo, sem `docker` no início, pois esse campo já o acrescenta:

```text
compose -p jrc-broker-broker-ophydn -f ./infra/dokploy/compose.yaml --profile maintenance run --rm --no-deps migrate
```

Salvar, abrir **General** e clicar **Deploy** uma vez. Em **Deployments → View**, acompanhar a execução. `--no-deps` usa o PostgreSQL já iniciado; se estiver parado, iniciar os serviços necessários antes da manutenção, sem apagar volumes.

O container `migrate` usa a imagem API nova. `runMigrations` executa `infra/app/postgres/init-roles.sql`, cria/normaliza as roles, assume `jrc_migrator` e aplica as migrações pendentes. Isso cria `jrc_lifecycle` também em bancos existentes. Em seguida, `infra/app/provision.mjs` configura as senhas dedicadas, inclusive `JRC_LIFECYCLE_PASSWORD`.

Esperar saída sem erro e a mensagem:

```text
Schema and dedicated roles provisioned.
```

Se aparecer erro de autenticação, role, schema, migração ou pull, corrigir a causa antes da próxima etapa. Um status verde isolado não substitui a leitura do log. O container de migração termina e é removido; ele não deve ficar `running` junto da aplicação.

## 4. Restaurar o comando e iniciar a aplicação

Em **Advanced → Run Command**, apagar todo o comando temporário e clicar **Save**. Confirmar a volta do comando padrão na prévia:

```text
docker compose -p jrc-broker-broker-ophydn -f ./infra/dokploy/compose.yaml up -d --build --remove-orphans
```

Abrir **General → Deploy** e acompanhar **Deployments → View**. O Compose inicia/recria API, WEB, workers e sandbox com os digests selecionados. PostgreSQL, Redis e Evolution continuam no mesmo stack. Não usar `down -v`, reset de banco ou exclusão manual de volumes para esta atualização.

Conferir o novo serviço **lifecycle-worker**. Ele usa exclusivamente a role `jrc_lifecycle` e processa solicitações de exclusão já autorizadas e persistidas. Não deve usar a credencial da API nem a do PostgreSQL administrador. Manter uma instância desse worker neste primeiro incremento; ampliar réplicas depende da validação de concorrência. Não executar purge SQL manualmente para testar o deploy.

## 5. Validar pelo painel e pelos terminais corretos

Em **Containers**, conferir API, worker de mensagens, PostgreSQL e Redis saudáveis, demais serviços em execução e ausência de reinícios contínuos. Verificar logs da API, automação, I/O, scheduler e `lifecycle-worker`. O serviço de exclusão não possui healthcheck Docker dedicado neste Compose; `running` sozinho não comprova conclusão de uma exclusão.

Em **View Config**, conferir a imagem de cada serviço contra o digest da release. API, workers e sandbox usam `JRC_API_IMAGE`; WEB usa `JRC_WEB_IMAGE`. Evitar compartilhar a configuração completa, pois contém variáveis privadas.

**Open Terminal** dentro de `broker` abre um container. Não executar `docker inspect` ou `docker compose` ali: esses comandos pertencem ao host Docker. Nesta sequência, o painel executa a manutenção no host correto, sem depender da sessão SSH de outro servidor.

No terminal do container **api**, selecionar `/bin/sh` e verificar a prontidão local:

```sh
node -e 'fetch("http://127.0.0.1:3000/ready").then(async r=>{console.log("HTTP",r.status);console.log(await r.text());process.exitCode=r.ok?0:1}).catch(()=>{console.error("READINESS_FAILED");process.exitCode=1})'
```

Esperar HTTP 200. `/ready` valida dependências básicas da API; não prova pareamento WhatsApp, bot publicado ou entrega na central.

No terminal do container **postgres**, verificar a role e as estruturas, em comandos de uma linha:

```sh
PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U postgres -d jrc_broker -X -v ON_ERROR_STOP=1 -c "SELECT rolname, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname='jrc_lifecycle';"
```

Esperado: uma linha, `rolcanlogin=t`, `rolsuper=f`, `rolbypassrls=f`.

```sh
PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U postgres -d jrc_broker -X -v ON_ERROR_STOP=1 -c "SELECT to_regclass('public.lifecycle_deletions') AS exclusoes, to_regclass('public.lifecycle_cleanup_items') AS limpeza, to_regclass('public.support_tickets') AS chamados, to_regclass('public.support_messages') AS mensagens;"
```

Esperado: quatro nomes de tabela, nenhum `NULL`. Para registrar o histórico do migrador:

```sh
PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U postgres -d jrc_broker -X -v ON_ERROR_STOP=1 -c "SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5;"
```

Confrontar o histórico com as migrações da imagem aprovada. A contagem antiga de 31, ou qualquer contagem isolada, não comprova hashes e estrutura. Os comandos usam a senha já existente na variável do container, sem imprimi-la.

## 6. Validar Flow, chamados e conexões

Com `AUTOMATION_RUNTIME_V2_ENABLED=false`, o comportamento esperado é:

- Proprietário/administrador de empresa ativa e módulo habilitado lista, cria e edita rascunhos, importa como rascunho e usa simulação pura.
- A interface informa execução pausada. Publicar/ativar fica bloqueado por `AUTOMATION_RUNTIME_DISABLED`, sem 503 genérico provocado apenas pela flag.
- Leitor não ganha edição/publicação. Empresa inativa ou módulo desabilitado produz a razão correspondente.
- Workers não iniciam novo trabalho V2 enquanto o runtime estiver pausado. Outros serviços do Broker continuam independentes dessa flag.

No ambiente de homologação autorizado, alterar `AUTOMATION_RUNTIME_V2_ENABLED=true` no ENV e fazer deploy normal, propagando o mesmo valor à API e aos workers. Executar o [bot de menu e captura](flow-disponibilidade-e-teste.md) e registrar a jornada real. Aplicar essa ativação em produção somente após a homologação. Não basta marcar “Habilitar automações” no plano da empresa.

`GET /v1/automations/status`, com sessão autorizada, informa `canRead`, `canEdit`, `canSimulate`, `canPublish` e `reasons`. `canPublish=true` exige empresa ativa, módulo e papel adequados, runtime ativo, schema/Redis disponíveis e heartbeat `UP` com idade máxima de 45 segundos para worker de mensagens, execução, I/O e scheduler. Dependência indisponível bloqueia publicação e preserva edição. Consultar **Saúde operacional** e aguardar a rodada de descoberta/heartbeat; se permanecer bloqueado, investigar logs em vez de ignorar o gate.

Numa empresa de homologação, abrir chamado em **Suporte** e conferir a solicitação na fila administrativa `/jrc/suporte`; atribuir, responder, resolver e conferir o histórico no workspace. Esse teste não envia notificação por WhatsApp/e-mail.

Para conexões e exclusão, usar recursos sintéticos de homologação: verificar prévia, permissões, estados persistidos e conclusão/erro da limpeza externa. Não excluir empresa ou canal real apenas para validar a instalação. Conta/caixa configurada na central não significa entrega verificada: testar mensagem recebida, resposta pública, bloqueio de nota privada e ausência de duplicidade no canal autorizado.

## 7. Registrar o resultado e encerrar a manutenção

Guardar no registro da release: commit da `main`, origem das imagens, digests API/WEB, sucesso do migrador, estado dos serviços, resposta de `/ready`, capacidade do Flow e resultados reais das jornadas homologadas. Registrar separadamente limitações externas ainda abertas; remover segredos e dados pessoais dos exemplos.

Reabilitar **Autodeploy** somente após confirmar que **Run Command** está vazio e que a política de publicação atualiza imagens de forma controlada. Autodeploy do Git sozinho não troca digests fixados no ENV.

Se o deploy falhar, restaurar o comando padrão e corrigir o erro identificado. Retornar a imagens anteriores exige verificar compatibilidade com o schema já migrado; este roteiro não executa rollback destrutivo de migrations. Exclusão concluída não é revertida pela troca da imagem.

Catálogo completo Flow/n8n, módulo instalado na central externa e capacidade em escala permanecem sujeitos aos gates próprios. Deploy concluído não transforma essas pendências em funcionalidades homologadas.
