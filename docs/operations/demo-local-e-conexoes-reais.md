# Demonstração local e conexões reais

**Acesso administrativo atualizado a pedido do usuário:** a demonstração local agora usa apenas `admin@jrc.local` e a senha já entregue. Não exige aplicativo nem código autenticador. A configuração de produção continua com MFA; detalhes em `saas-admin.md`. As instruções de matrícula abaixo registram a configuração inicial.

**Atualização do QR em 14/09/2026:** o motor privado foi construído e iniciado posteriormente. O QR real foi validado no navegador na conexão `welton-qr` da Empresa Demo Alfa. Consulte `diagnostico-login-qr-local.md`. As referências abaixo à ausência do motor descrevem a preparação inicial. Meta, Typebot e envios reais continuam pendentes de configuração/homologação.

Ambiente iniciado em 14/09/2026, projeto Docker `jrc-demo-local`. Somente a porta `127.0.0.1:8088` está publicada; não é acessível por outros computadores. Banco e Redis possuem volumes persistentes separados dos outros projetos Docker.

## Acessos e roteiro

- Administração: http://127.0.0.1:8088/jrc — identidade `admin@jrc.local`, SUPER_ADMIN com senha e TOTP.
- Clientes: http://127.0.0.1:8088/login — `cliente.alfa@jrc.local` e `cliente.beta@jrc.local`, cada um OWNER da sua empresa Demo.
- Senhas aleatórias e matrícula MFA estão em `.sessions/demo/acesso-local.txt`, ignorado pelo Git. São exclusivos desta demonstração. Não reutilizar no servidor.
- No autenticador, adicionar uma conta por chave de configuração: usar a chave MFA do arquivo, código baseado em tempo, seis dígitos e período de 30 segundos. Usar o código atual no campo Código do autenticador. Um código já utilizado não pode ser repetido.

Na administração, abrir Alfa/Beta e conferir responsáveis, limites, situação e monitoramento. O motivo do atendimento acompanha a auditoria. No portal, entrar, selecionar a empresa e abrir Minha empresa, Conexões, WhatsApp oficial e Mensagens. Os indicadores começam vazios: nenhuma mensagem ou conexão real foi criada.

Verificado neste ambiente: autenticação administrativa com MFA, criação das duas empresas via API auditada, monitoramento, login e seleção de ambas as empresas e rejeição dos acessos de cliente à API administrativa.

## Iniciar e parar novamente

Executar na raiz do repositório com Docker Desktop aberto:

```powershell
docker compose -p jrc-demo-local --env-file .sessions/demo/.env -f infra/dokploy/compose.yaml -f .sessions/demo/compose.local.yaml up -d postgres redis api web evolution
```

Para parar preservando banco e configuração:

```powershell
docker compose -p jrc-demo-local --env-file .sessions/demo/.env -f infra/dokploy/compose.yaml -f .sessions/demo/compose.local.yaml stop
```

Não usar `down -v` para parar: remove os volumes. O override local usa desenvolvimento e cookies HTTP somente em loopback. O Compose de Dokploy continua exigindo HTTPS e cookies Secure.

## O que a JRC precisa preparar na Meta

1. Ter acesso administrativo ao portfólio empresarial JRC no Meta Business e concluir as verificações exigidas para o programa Tech Provider. O aplicativo deve pertencer à JRC.
2. Criar/configurar o aplicativo com o caso de uso WhatsApp e Facebook Login for Business. Criar a configuração Embedded Signup e obter App ID e Config ID. Guardar App Secret somente no servidor.
3. Definir domínio HTTPS de homologação para o broker. Cadastrar esse domínio no aplicativo e nas configurações de login/JavaScript SDK. A demonstração HTTP local não recebe callbacks externos nem conclui Embedded Signup.
4. Publicar política de privacidade, termos e instruções/endpoint de exclusão conforme exigências do painel. Concluir App Review e Advanced Access das permissões usadas, incluindo `whatsapp_business_management` e `whatsapp_business_messaging`; conferir `business_management` para as operações específicas do fluxo. Preparar vídeo e instruções reproduzíveis para a revisão. A lista final depende do caso de uso e do painel vigente.
5. No servidor configurar `META_APP_ID`, `META_APP_SECRET`, `META_SIGNUP_CONFIG_ID`, `META_GRAPH_VERSION`, `META_TOKEN_ENCRYPTION_KEY` e `META_WEBHOOK_VERIFY_TOKEN`. Escolher versão Graph suportada e homologá-la; não presumir compatibilidade de uma versão nova. A chave de cifragem é distinta, 32 bytes em base64, com backup protegido.
6. Configurar callback `https://SEU-DOMINIO/v1/webhooks/meta`, com o mesmo Verify Token do servidor. Assinar `messages` e os eventos de conta necessários à implementação (`account_update`, `account_review_update`). Confirmar assinatura do aplicativo no WABA.

O cliente acessa WhatsApp oficial no portal, autoriza os ativos pelo Embedded Signup e seleciona seu próprio portfólio/WABA/número. Ele não cria aplicativo nem desenvolve integração. Precisa de permissão administrativa sobre os ativos, acesso ao número para verificação, nome de exibição e configuração financeira exigida pela Meta. Registro/PIN, análise, pagamento ou webhook pendentes mantêm o envio bloqueado.

Para começar, usar ativos de teste ou número dedicado autorizado. Coexistence e migração de número já em uso não foram homologados neste incremento; não remover uma conta existente para forçar o cadastro. Primeiro validar recebimento, assinatura, status, template aprovado e resposta Typebot em homologação. Qualquer envio real continua dependendo de autorização explícita. Campanhas completas e mídias permanecem fora deste incremento.

## Baileys e Typebot

O motor Baileys não está em execução nesta demonstração: não havia imagem local revisada do motor. O painel permite conhecer o fluxo, mas não produzirá QR funcional enquanto o provider estiver indisponível. É preciso construir/revisar a imagem do motor preservado, configurar `EVOLUTION_ENGINE_IMAGE`, iniciar o serviço privado e validar a comunicação com a API. Depois, o usuário autorizado cria uma instância em Conexões e pareia o QR temporário pelo WhatsApp do número autorizado. A sessão fica vinculada à empresa/instância, com credenciais no servidor. Evolution permanece adaptador interno preservado, sem substituir a API JRC.

No Typebot, criar e publicar o fluxo no editor externo; obter o publicId e a origem HTTPS do viewer. Configurar a origem permitida por organização em `TYPEBOT_ORIGINS_JSON` e vincular o bot ao canal em Mensagens. Configurar credenciais de IA nos blocos do Typebot, quando utilizados. Homologar startChat/continueChat, respostas e pausa para atendimento humano.

O worker também está parado nesta demonstração sem canais. Antes de ativar automações reais, configurar os UUIDs das organizações em `MESSAGING_WORKER_ORGANIZATIONS`, credenciais/origens e iniciar o serviço worker. Atualizar essa partição ao cadastrar novas empresas. Não basta preencher o formulário do bot para habilitar processamento.

## Informações necessárias para a próxima configuração

- Domínio HTTPS de homologação e acesso ao ambiente Dokploy.
- Situação do portfólio/app JRC, App ID e Embedded Signup Config ID.
- Número/ativos autorizados para homologação e situação de pagamento/revisão.
- Origem HTTPS e publicId do fluxo Typebot publicado.
- Imagem revisada do motor Baileys e número autorizado para pareamento.

App Secret, tokens e senhas devem ser configurados no ambiente protegido; não colocar no frontend, Git ou chamados. Nenhuma imagem foi publicada e nenhum recurso externo foi conectado por esta inicialização local.

## Fontes oficiais consultadas

- [Exemplo Meta Tech Provider e configuração do app](https://github.com/fbsamples/business-messaging-sample-tech-provider-app/blob/main/README.md).
- [Coleção oficial Meta Embedded Signup](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup).
- [Typebot: Start chat](https://docs.typebot.com/api-reference/chat/start-chat).
- Guias deste repositório: `dokploy-saas.md`, `saas-meta.md` e `meta-typebot.md`.
