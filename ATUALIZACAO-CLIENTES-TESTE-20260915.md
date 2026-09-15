# Atualização — identidade JRC e clientes de teste

## Marca e canais

O portal do cliente agora apresenta **Canais JRC**, com duas modalidades:

- **WhatsApp Business por QR Code**: conexão por dispositivo, usando a engine interna já prevista na arquitetura.
- **WhatsApp Oficial**: autorização dos ativos Meta da empresa.

Nomes de motores e comparativos de fornecedores foram retirados das jornadas do cliente. Licenças, atribuições e documentação técnica foram preservadas. Contas antigas com nomes Baileys/Evolution recebem rótulos JRC na interface, mantendo os identificadores e contratos do backend.

## Ambiente local real

Foi criada uma stack separada, `jrc-broker-test-20260915`, com volumes persistentes próprios. Ela usa PostgreSQL 16.4, Redis 7.4 e a imagem oficial `evoapicloud/evolution-api:v2.3.7`, fixada pelo digest `sha256:1bd8afc4a6cf48822e6cf02469aeae7bd35a12a6b616eacd1291926307f4d339`.

Essa imagem é o artefato publicado para teste local; não equivale à verificação do gitlink do snapshot upstream no ZIP. A referência da imagem foi conferida no [Compose oficial](https://github.com/evolution-foundation/evolution-api/blob/main/Docker/swarm/evolution_api_v2.yaml).

Todos os serviços deste teste escutam somente no loopback do computador:

| Serviço | Endereço |
|---|---|
| Portal dos clientes | http://127.0.0.1:4317/login |
| Administração JRC | http://127.0.0.1:4317/jrc |
| API JRC | 127.0.0.1:3000 |
| Banco do teste | 127.0.0.1:55432 |
| Redis do teste | 127.0.0.1:16379 |
| Engine privada local | 127.0.0.1:58080 |

Os endereços internos não são opções de conexão mostradas aos clientes. O portal encaminha a API pela mesma origem.

## Contas criadas

| Empresa | Usuário | Papel | Conexão preparada |
|---|---|---|---|
| Cliente Teste 01 | cliente01@jrc.test | Proprietário da própria empresa | WhatsApp Cliente Teste 01 |
| Cliente Teste 02 | cliente02@jrc.test | Proprietário da própria empresa | WhatsApp Cliente Teste 02 |
| Administração JRC | admin@jrc.test | SUPER_ADMIN separado dos tenants | Não aplicável |

Cada cliente tem limite de 2 conexões, 3 usuários, 100 envios/dia e 50 pendências. Os e-mails são identificadores locais de teste, sem serviço de caixa postal. As senhas ficam no arquivo privado `.sessions/teste-clientes/ACESSOS-TESTE-JRC.md`, fora do Git e do ZIP.

Por solicitação explícita do usuário, o administrador deste ambiente local passou a usar somente e-mail e senha, com `PLATFORM_LOCAL_PASSWORD_ONLY=true`. A API foi reiniciada e o login sem TOTP foi validado. O modo exige desenvolvimento e origem HTTP de loopback; a configuração da implantação é independente.

## Evidência operacional

Executado em PostgreSQL real com o runtime `jrc_app` sem superuser/BYPASSRLS:

- Migrações e criação das contas concluídas.
- Os dois logins retornam somente a empresa do respectivo cliente.
- Uma instância foi provisionada na engine para cada empresa.
- A conexão da outra empresa retorna HTTP 404.
- Token de cliente não autentica no painel da plataforma, retornando HTTP 401.
- Consulta de instâncias sem filtro WHERE, dentro da transação da empresa, retorna somente a linha do tenant, comprovando a aplicação de RLS nesse cenário.
- O endpoint overview foi executado no PostgreSQL real e contou uma conexão por cliente.

Essa verificação complementa a entrega anterior; não representa auditoria de todos os caminhos de acesso ou teste de carga.

Após a atualização da marca: build e typecheck aprovados; **156 testes da interface aprovados em 24 arquivos**; scanner do bundle sem achados; atribuições do navegador aprovadas. O login do Cliente Teste 01 também foi validado no navegador com a empresa e a conexão reais.

## Usar e retomar

**Interface administrativa atualizada:** `/jrc` agora apresenta o dashboard com menu lateral,
cartões, gráficos e tabelas no tema JRC. Empresas, usuários e limites existentes foram
preservados. Veja [a atualização da administração](ATUALIZACAO-ADMIN-20260915.md).

1. Abra o portal sem `?demo=1` e entre com um usuário de teste.
2. Selecione sua empresa, abra **Conexões** e a conexão preparada.
3. Gere o QR Code e use **WhatsApp Business → Aparelhos conectados → Conectar aparelho** no celular correspondente.
4. Para duas sessões simultâneas no mesmo computador, use perfis separados ou uma janela privativa.

O pareamento exige a leitura do QR Code pelo titular. A mensageria/inbox unificada para conexões por QR Code continua pendente, conforme o plano mestre. O WhatsApp Oficial depende da configuração do aplicativo Meta da JRC e da autorização dos ativos; não foi habilitado com credenciais reais nesta etapa.

Para retomar esta mesma cópia de trabalho, na raiz do projeto:

```powershell
docker compose --env-file .sessions/teste-clientes/runtime.env -f .sessions/teste-clientes/compose.yaml --profile qr up -d
node .sessions/teste-clientes/start-api.mjs
```

Em outro terminal:

```powershell
npm run dev:web
```

Não iniciar cópias adicionais dos processos enquanto as portas já estiverem em uso. Os arquivos `.sessions` e os volumes Docker são exclusivos desta máquina e não acompanham o pacote de fontes.

## Ajustes do ambiente Windows

Foi preservada a pasta de sockets temporários do Docker em `AppData/Local/Docker/run.stale-jrc-20260915` durante o diagnóstico de inicialização. Bancos/volumes anteriores foram preservados. O Docker está ativo. A pasta de credenciais tem acesso restrito a DEV03 e SYSTEM; seus arquivos privados mantêm herança desativada quando receberam ACL explícita. Nenhuma credencial real entrou na documentação pública ou no pacote de fontes.
