# SaaS JRC no Dokploy

Fontes e workflows de entrega: [ClaudioHideki/BrokerJRCIA](https://github.com/ClaudioHideki/BrokerJRCIA). Confira na aba Actions o resultado da revisão que pretende instalar. A publicação de imagens não implanta a stack no servidor. Evolution/Ligo continuam referências; a API e o portal públicos pertencem à JRC. O motor Baileys preserva o isolamento por organização/instância existente.

## Serviços e credenciais

Use `infra/dokploy/compose.yaml` e `infra/dokploy/.env.example`. A imagem `runtime` atende API e worker; a imagem `web` serve o frontend e encaminha `/v1/` à API na mesma origem. PostgreSQL/Redis/motor não publicam portas no host. O motor dispõe de banco e usuário próprios, sem a senha de superusuário do broker. API, autenticação e administração usam respectivamente `jrc_app`, `jrc_auth` e `jrc_platform`, todos NOSUPERUSER/NOBYPASSRLS. A credencial migradora só existe no serviço pontual `migrate`.

API e web executam como usuário Node não privilegiado; Compose limita memória/CPU e remove capabilities. O worker não recebe `PLATFORM_DATABASE_URL` nem `PLATFORM_MFA_KEY`. A rede backend é interna; API/worker/motor possuem saída necessária a Meta/Typebot/WhatsApp. Rede interna sem saída não serviria ao Baileys.

Gere valores diferentes para cada segredo, com pelo menos 32 caracteres aleatórios; senhas usadas em URL devem ser hexadecimais ou corretamente percent-encoded. MFA e tokens Meta usam chaves distintas de 32 bytes codificadas em base64. Guarde-as em cofre e no backup de segredos, nunca em Git ou no build do frontend. `.env.example` não contém credenciais funcionais.

## Preparação e instalação futura

1. Após revisão e autorização de publicação, execute o workflow manual `images.yml` no ambiente GitHub `ghcr-release`; `publish=false` é o padrão. `publish=true` publica tags da revisão Git em GHCR. Revisores adicionais podem ser configurados nesse ambiente conforme a política da equipe. Configure o segredo de repositório `AUDIT_FINGERPRINT_SECRET` com valor aleatório exclusivo para a CI. Não há webhook de deploy automático. Execute também a CI de integração/E2E antes da liberação; o job de imagens não substitui essa CI.
2. Registre no Dokploy as duas imagens por digest resultante, nunca como `latest`, e a imagem revisada do motor. Cadastre o registry GHCR com acesso mínimo de leitura se privado. Guarde o digest anterior para rollback.
3. Crie aplicação Docker Compose e carregue os arquivos de `infra/dokploy`. Preencha o ambiente. Defina um domínio HTTPS para o serviço **web**, porta **8080**, pela aba Domains. Use a mesma origem exata em `PUBLIC_ORIGIN`. Não aponte domínio ao PostgreSQL, Redis ou motor.
4. Inicialize somente `postgres` e `redis`. Execute `docker compose --env-file .env -f infra/dokploy/compose.yaml --profile maintenance run --rm migrate` em janela de manutenção. Esse comando aplica migrations e configura os usuários dedicados; não deve rodar em cada inicialização da API. Faça backup antes de executá-lo em uma base existente.
5. Crie o primeiro administrador com `npm run platform:admin:create` dentro da imagem, usando credenciais administrativas em ambiente temporário. O modo solicitado é `PLATFORM_LOGIN_MODE=password`: acesso por e-mail e senha, sem aplicativo autenticador. A chave `PLATFORM_MFA_KEY` continua obrigatória para compatibilidade do armazenamento. Configure `PLATFORM_ORIGIN=PUBLIC_ORIGIN` com HTTPS. Remova as variáveis da senha inicial após criar o administrador.
6. Inicie API/web/motor/worker. Acesse `/jrc` para administrar empresas e `/login` para o portal dos clientes. O Compose usa `MESSAGING_WORKER_MODE=automatic`: empresas novas entram no processamento sem editar listas. Para distribuir entre workers, configure o mesmo total `MESSAGING_WORKER_SHARDS=N` e índices distintos de `0` a `N-1`. A descoberta fornece somente IDs; todas as operações de dados continuam sob RLS.
7. Faça homologação com ativos de teste Meta e número Baileys autorizado antes do tráfego real. Configure App ID, App Secret, Embedded Signup Config ID, versão Graph explícita, chave de criptografia e verificação do webhook na JRC. O cliente autoriza ativos; não cria um aplicativo. Siga o guia SaaS Meta para as pendências de número, análise e pagamento.

Valide a interpolação sem imprimir segredos: `docker compose --env-file .env -f infra/dokploy/compose.yaml config --quiet`. Não salve `docker compose config` completo em chamados. As variáveis ainda precisam ser configuradas no servidor real.

O proxy web descarta cabeçalhos de identidade encaminhados pelo navegador. O rate limit por identidade permanece ativo; a limitação por IP vê o proxy quando não existe cadeia confiável configurada. Antes da abertura pública, configure e teste a cadeia de proxies conhecida no ambiente, incluindo a política de IP da borda. Não aceite `X-Forwarded-For` irrestrito.

## Operação e limites

Cada organização possui limites de conexões, usuários, mensagens aceitas por dia UTC e pendências. Verificações transacionais protegem requisições concorrentes; o frontend apenas informa. Reduzir limite abaixo do uso não apaga registros: bloqueia novas admissões até caber no limite. Pendências suspensas não são apagadas; envios já em voo conservam o resultado. Um resultado desconhecido não é reenviado cegamente. Eventos recebidos e de entrega continuam duráveis mesmo durante suspensão.

Os workers percorrem a partição com quantidade limitada por empresa a cada rodada. Configure partições menores para atender latência contratada e isolar canais lentos; não atribua o mesmo conjunto inadvertidamente a centenas de processos. Redis usa `noeviction`, evitando que pressão de memória remova chaves de segurança silenciosamente; monitore uso e falhas.

UI: `/jrc` apresenta empresas, limites, usuários, indicadores e a aba JRC Conversas; SUPPORT não recebe edição administrativa. `/integracoes` permite vincular conta, caixas, atendentes e consultar entregas. `/whatsapp-oficial` orienta autorização/pendências; `/conexoes` orienta QR e reconexão; `/mensagens` oferece texto, anexos recebidos, templates e Typebot. A edição de fluxos continua no Typebot publicado, conectado por API.

`/health` verifica o processo; `/ready` verifica banco, schema e Redis. O worker possui verificação de atividade. Este Compose em um único servidor não oferece alta disponibilidade: cluster, failover de banco e sessões QR exigem arquitetura e teste adicionais. Redis não é a fila de mensagens do broker; inbox, outbox, tarefas e anexos ficam no PostgreSQL.

## Backup e recuperação

Política inicial proposta: backup diário criptografado, 30 dias de retenção e cópia fora do servidor. Esses valores são configuração operacional, não uma rotina já instalada. Para RPO inferior a 24 horas, habilite arquivamento WAL/PITR e teste o destino. RTO só pode ser declarado após medir uma restauração no servidor alvo.

Inclua banco `jrc_broker`, banco `jrc_evolution`, volume `engine_instances`, dados Redis necessários ao motor, configuração, digests e chaves de criptografia guardadas separadamente. O utilitário `scripts/operations/backup.mjs` cifra os dois dumps, roles, arquivos de sessão do motor e ambiente; veja [integração e recuperação](integracao-jrc-conversas.md). Redis requer snapshot consistente separado do volume `redis_data`. Sem as chaves de integração, Meta e administração, os registros cifrados não podem ser recuperados.

Restauração: isole a nova stack da internet e mantenha os workers parados; restaure base/roles, recupere chaves, valide versão de schema, RLS e amostras de duas empresas; reconcilie mensagens SENDING/UNKNOWN antes de reativar envio. Um backup antigo pode conter mensagens já entregues depois do snapshot. Não religue filas indiscriminadamente. Sessões externas podem exigir novo QR ou nova autorização Meta; a restauração local não desfaz revogações externas.

Recuperar uma única organização exige restaurar o backup completo em ambiente isolado e extrair apenas as tabelas/linhas daquele tenant, preservando FKs, idempotência e histórico de auditoria. Nunca sobrescreva a base multitenant ativa com o backup de uma empresa. Cadastros de usuários podem ser compartilhados entre organizações: não sobrescreva senha ou identidade global ao recuperar uma filiação.

## Retenção e exclusão por organização

Suspensão/desativação não é exclusão. Nenhuma rotina desta entrega apaga automaticamente mensagens, arquivos, sessões ou auditoria. Defina prazos por contrato e finalidade, incluindo mensagens, contatos, inbox/outbox, logs e backups, antes de ativar um job de retenção.

Exclusão exige solicitação identificada, aprovação administrativa, inventário do tenant, pausa de produtores/workers e revogação de tokens/API keys/sessões. Exclua recursos externos somente para a instância autorizada; não remova ativos de propriedade do cliente na Meta. Remova filiações sem excluir usuários compartilhados por outras organizações. Respeite relações de auditoria com `ON DELETE RESTRICT`: não faça cascata arbitrária para contornar retenção de evidências. Registre evidência da operação e a expiração prevista das cópias de backup; suporte não possui endpoint de SQL/exclusão genérica.

Anexos são armazenados cifrados no PostgreSQL e baixados por endpoint autenticado, com isolamento da organização. Limites: 16 MiB por arquivo, 5 MiB por imagem e 500 KiB por sticker; cota padrão de 1 GiB por empresa. Se o Chatwoot utilizar armazenamento externo, inclua somente suas origens HTTPS exatas em `CHATWOOT_MEDIA_ORIGINS`. URLs recebidas em webhooks nunca autorizam downloads por si só. Credenciais Baileys permanecem no motor privado; QR é temporário e restrito à operação autorizada.

## Referências verificadas

- [Dokploy: Docker Compose](https://docs.dokploy.com/docs/core/docker-compose) e [domínios por serviço](https://docs.dokploy.com/docs/core/docker-compose/domains).
- [GitHub: publicação de imagens](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images) e [Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

Consulte também `saas-admin.md`, `saas-enforcement.md`, `saas-meta.md` e `meta-typebot.md` para contratos, testes e fronteiras externas.
