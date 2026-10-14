# Atualização consolidada do Broker e módulos da central

O Broker, o JRC Conversas e uma instalação externa de Chatwoot continuam sendo sistemas separados. A imagem API executa os serviços e workers do Broker; a imagem web fornece sua console. Os módulos em `infra/modules` são pacotes de código para a central e precisam ser instalados e compilados na imagem da própria central. Atualizar o Broker não instala esses módulos no JRC Conversas.

## Imagem e banco

A revisão de código da API e da web deve ser a mesma publicada na `main`. Use os dois digests do artefato `image-release.json` da execução de imagens aprovada. Não combine uma API nova com a web antiga. A baseline estrutural deste corte é `0060_consolidated_runtime_integrity`; ela inclui as migrações anteriores e não autoriza reaplicar SQL manualmente.

No Dokploy, mantenha repositório `ClaudioHideki/BrokerJRCIA`, branch `main` e Compose Path `./infra/dokploy/compose.yaml`. Atualize `JRC_API_IMAGE` e `JRC_WEB_IMAGE` com o par verificado. Preserve as credenciais e os volumes existentes. O comando a seguir é de manutenção no diretório do checkout usado pelo Dokploy, não no terminal do container API:

```sh
docker compose -p jrc-broker-broker-ophydn -f ./infra/dokploy/compose.yaml --profile maintenance run --rm migrate
```

Faça essa etapa depois do backup e antes de iniciar a API nova. O serviço `migrate` termina com código zero; não é um worker permanente. Após a conclusão, o deploy normal usa:

```sh
docker compose -p jrc-broker-broker-ophydn -f ./infra/dokploy/compose.yaml up -d --build --remove-orphans
```

Se o comando de manutenção foi usado no campo Advanced → Run Command, apague esse campo e salve antes de General → Deploy. Deixá-lo preenchido executa apenas a manutenção em cada deploy. Não use `down --volumes`.

## Configuração

`AUTOMATION_RUNTIME_V2_ENABLED=true` habilita o motor usado pelo Flow. As credenciais de IA são cadastradas por empresa, com modelo e política de orçamento; não há uma chave global de IA compartilhada entre tenants. Os valores de custo são estimativas configuradas pelo operador.

O destino Evolution tradicional permanece `evolution:8080` no Compose atual. A distribuição por vários motores é opcional e exige configuração privada e registro administrativo explícito: veja [operação da frota](evolution-fleet.md). A migration não move sessões WhatsApp nem cria servidores. Para usar S3/MinIO, siga [armazenamento privado](private-media-minio.md); as variáveis já existentes precisam ser iguais nos processos que acessam os objetos.

Para Chatwoot externo, a integração por URL, conta e token continua usando as permissões dessa instalação. O editor Flow e a conexão QR dentro da central exigem o módulo correspondente e seu vínculo autorizado. Cadastrar URL/token por si só não acrescenta páginas a um servidor Chatwoot que o Broker não administra.

## Verificação após instalação

No terminal do container `api`, execute separadamente:

```sh
node -e 'fetch("http://127.0.0.1:3000/ready").then(async r=>{console.log(r.status);console.log(await r.text())})'
```

```sh
node -p 'process.env.AUTOMATION_RUNTIME_V2_ENABLED'
```

```sh
node --input-type=module -e 'import{RUNTIME_SCHEMA_BASELINE}from"/app/apps/api/dist/db/runtime-schema.js";console.log(RUNTIME_SCHEMA_BASELINE)'
```

Os resultados esperados são HTTP 200/ready, `true` e `0060_consolidated_runtime_integrity`. A readiness verifica a estrutura necessária, mas não substitui a comparação do journal/hash feita pela manutenção nem o teste funcional.

A homologação começa pela conversa pessoal do Welton, autorizada para teste: mensagem recebida, menu, captura, transferência, resposta humana e retomada. Depois entram os dois tenants JRC e a instalação externa ainda a configurar, grupos, mídias, reconexão e revogação. Guarde revisão da imagem, IDs de correlação e resultado observado. CI com transportes sintéticos não comprova a entrega no WhatsApp.

Chamadas com áudio bidirecional, elegibilidade Meta, capacidade física de 10.000 conexões e recuperação integral do servidor ainda precisam das provas de provedor e infraestrutura descritas no programa. Eventos de chamada ou um teste lógico não são essas provas.
