# Administração da plataforma SaaS

Identidade da plataforma é independente de `users`/`memberships`: `SUPER_ADMIN` administra empresas e vínculos; `SUPPORT` consulta dados administrativos, métricas agregadas e registra reconhecimento de atendimento. JWT e API key tenant não autenticam nenhuma rota `/v1/platform`.

## Configuração e primeiro operador

### Exceção solicitada para a demonstração local

Em 14/09/2026 o usuário solicitou login apenas por e-mail e senha. O override privado `.sessions/demo/compose.local.yaml` habilita `PLATFORM_LOCAL_PASSWORD_ONLY=true`. A aplicação aceita essa opção somente com NODE_ENV=development e PLATFORM_ORIGIN HTTP de loopback (127.0.0.1, localhost ou ::1). Tentativas de usar o modo em produção ou com domínio remoto impedem a inicialização. O Compose Dokploy não habilita a opção e continua exigindo MFA.

`GET /v1/platform/auth/config` informa somente `{mfaRequired}` para a tela. A validação é do servidor: omitir o código não desativa MFA quando a opção está ausente. No modo local continuam obrigatórios senha válida, conta administrativa ativa, limite de tentativas, cookie HttpOnly, Origin/CSRF, segregação de papéis e auditoria. O log de auditoria identifica explicitamente a autenticação por senha no ambiente local, sem afirmar que MFA foi validado. A seed existente é preservada para reativação posterior.

Definir `PLATFORM_DATABASE_URL` com login **jrc_platform** dedicado, `PLATFORM_MFA_KEY` com 32 bytes aleatórios em base64 e `PLATFORM_ORIGIN` com a origem exata do console (sem caminho/barra final). O serviço verifica o usuário PostgreSQL e recusa superuser/BYPASSRLS. As migrations são executadas separadamente pelo migrador; a conta da aplicação não recebe privilégios de plataforma. HTTPS é necessário na implantação para cookies Secure.

Após compilar, executar `node apps/api/dist/commands/platform-admin-create.js` com as variáveis anteriores e `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD` (12–256 caracteres), `PLATFORM_ADMIN_ROLE` opcional (`SUPER_ADMIN` ou `SUPPORT`). O comando cria apenas uma identidade nova, registra auditoria e apresenta uma URI `otpauth` de matrícula. Executar em terminal privado, sem gravação de saída/CI; importar imediatamente no autenticador. A seed fica cifrada AES-256-GCM no servidor. Guardar a chave em secret manager e incluí-la no plano de recuperação protegido, separado do backup de dados.

Não existe reset MFA por email nem senha de recuperação. Operador autorizado com acesso operacional ao banco deve desativar a identidade (`platform_users.active=false`) para revogar seu acesso imediatamente, e cadastrar uma identidade substituta pelo comando. Remover sessões expiradas e contadores expirados por tarefa operacional de retenção; o acesso sempre testa expiração, independentemente da limpeza física.

## Contratos

- `POST /v1/platform/auth/login`: `{email,password,totp}`. Retorna `{user:{id,email,role},csrfToken,expiresAt}`; cookie `platform_session` HttpOnly, SameSite=Strict, Path `/v1/platform`, duração 15 minutos. Token aleatório de 256 bits; somente SHA-256 armazenado no banco.
- `GET /auth/session`: mesmo DTO de sessão; `POST /auth/logout`: revoga o token no banco.
- `GET /organizations`: `{organizations:[{id,name,slug,status,plan,limits}]}` (até 200 organizações mais recentes).
- `POST /organizations`: `{name,slug,ownerEmail,ownerPassword,plan?,limits?}` cria empresa, novo usuário responsável OWNER e conta lógica Baileys. Email existente causa conflito sem alterar senha de outro usuário.
- `PATCH /organizations/:id`: `{status?,plan?,limits?}`; status ACTIVE/SUSPENDED/DISABLED, `limits={maxInstances,maxUsers,messagesPerDay,maxPendingMessages}` positivos. As regras de enforcement estão na migration 0011.
- `GET /organizations/:id/memberships`: `{memberships:[{userId,email,role,status}]}`.
- `PUT /organizations/:id/memberships`: `{email,password?,role,status}`; senha obrigatória apenas para usuário novo. Papéis OWNER/ADMIN/OPERATOR/VIEWER nunca promovem identidade à plataforma. Invariante de último OWNER preservada pelo banco.
- `GET /organizations/:id/monitor`: `{connections,queue,failures,webhooks}`. Connections soma instâncias conectadas e canais Meta configurados (não é garantia de saúde Graph API); demais campos são contagens, sem conteúdo/telefone/token.
- `POST /organizations/:id/support-acknowledgment`: `{}` registra reconhecimento de suporte, retorna `{ok:true}`.

Rotas operacionais exigem `x-platform-reason` com 5–500 caracteres. Mutações exigem também Origin exata e `x-csrf-token` da sessão; login exige Origin. Todas as operações permitidas são auditadas na mesma transação, e falha de auditoria impede a alteração/resposta de consulta. Não há impersonação, reenvio cego, leitura de mensagens ou credenciais. Suporte pode somente listar empresas/vínculos, consultar monitor e reconhecer atendimento.

TOTP valida janela de 30 segundos com tolerância de um passo e trava a linha do usuário, impedindo replay concorrente. Limites de login no PostgreSQL por identidade e IP: 10 tentativas por 15 minutos; falha do armazenamento bloqueia autenticação. IP é o peer da conexão; atrás de proxy a restrição pode ser compartilhada entre operadores (conservadora).

## Evidência local

TDD observado para ausência inicial de módulos, acknowledgment SUPPORT negado e criação de empresa sem conta Baileys (0 em vez de 1). Testes focados cobrem RFC TOTP, cifragem autenticada, cookies/Origin/CSRF, rejeição de bearer tenant, grants dos dois papéis runtime, replay e revogação, falha fechada do limitador, duas organizações, isolamento de vínculos e rollback por falha de auditoria.

`npx tsc -b apps/api --pretty false`: passou. `npx vitest run apps/api/src/modules/platform/crypto.test.ts apps/api/src/http/routes/platform.test.ts`: 3 testes passaram. `npx vitest run --config vitest.integration.config.ts apps/api/tests/integration/platform.test.ts` com PostgreSQL isolado: 5 testes passaram. Nenhum comando de matrícula real, envio, commit, push ou deploy executado.

Limitações explícitas: listagem limitada a 200 (sem paginação), suporte não altera tenant, configuração de limites por empresa (sem catálogo comercial de planos), sem UI de recuperação MFA, dados de monitor agregados cumulativos. A administração depende de provisionamento de credencial PostgreSQL dedicada e HTTPS operacional antes de publicação.
