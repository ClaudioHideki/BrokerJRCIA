# B02 — Administração de clientes: plano de lote

Complementa Tasks3–5 do plano complete-broker; não autoriza publicação ou concessão de privilégios no banco de demonstração.

## Task3 — Identidade administrativa separada

- Criar migration0009_platform_permissions.sql, sem reescrever migrations anteriores: tabela platform_permissions vinculada ao usuário, permission limitada a platform:clients:read/create/suspend, unicidade usuário+permission, concessão e revogação auditáveis.
- jrc_app não lê nem grava concessões; jrc_auth obtém somente projeção de permissões efetivas por função interna de leitura com search_path fixado e PUBLIC revogado. Nenhuma rota concede privilégios. Usuário desativado não possui permissão efetiva.
- Serviço requirePlatformPermission recebe identidade JWT verificada, rejeita API key, consulta permissão a cada chamada, nunca usa papel OWNER como privilégio da plataforma. Erro genérico403, sem revelar usuário/estrutura interna.
- Contrato compartilhado separado da sessão existente; não alterar claimsJWT nem relaxar schemas da console.
- CLI platform-admin concede/revoga em transação administrativa existente, com credencial operacional por entrada segura, confirmação explícita e auditoria atômica. Não recebe senha/credencial em argv, não imprime PII. Não executar contra dados do usuário neste lote.
- RED/GREEN unitário: todos os papéis de tenant sem concessão negados, APIkey negada, permissão específica, revogação/desativação invalida autorização. PostgreSQL: grants reais, chamadas concorrentes e atomicidade da auditoria; jrc_app não altera/grava/executa projeção administrativa.
- Composição HTTP será modificada na Task4, quando haverá rotas consumidoras; Task3 entrega primitivas e comando, não endpoints artificiais.

## Task4 — Operações de clientes

- GET/POST /v1/platform/clients; POST /v1/platform/clients/:id/suspend. Zod strict, paginação, no-store, request_id, autenticação JWT e autorização específica revalidada.
- Não passar DATABASE_ADMIN_URL/jrc_migrator ao servidor HTTP. Operações restritas por funções de banco com autorização do ator e grants mínimos; nenhuma função genérica de execuçãoSQL. Atomicidade inclui OWNER, account, auditoria e idempotência, sem chamadas externas.
- CREATE_NEW não redefine senha de usuário existente; LINK_EXISTING requer confirmação explícita. Convites da Task5 substituem senha provisória antes de homologar onboarding completo.
- Revogação/suspensão testadas pelo servidor, inclusive JWT/APIkeys já emitidos, não apenas escondidas na interface.
- Inspeção inicial: authenticateRequest valida assinatura JWT; withOrganizationTransaction define o contexto mas não consulta status da organização; políticas atuais isolam por ID. Portanto Task4 precisa acrescentar verificação de organização ativa na fronteira de operação e testes de tokens/chaves emitidos antes da suspensão. Não basta atualizar a tabela organizations. Operações internas de auditoria/cleanup precisam caminho explícito e restrito, sem reabrir mutações normais do cliente suspenso.
- Interface /administracao/clientes separada da área do tenant. Descoberta de capacidades do usuário via endpoint autenticado sem conceder privilégio por UI; servidor sempre decide.
- Sessão administrativa de produção requer reautenticação/MFA conforme especificação; enquanto não implementadas, manter recursos administrativos HTTP desabilitados em produção, sem bypass silencioso.
- Testar composição Fastify real, PostgreSQL isolado e jornada de navegador com dois clientes. Atualizar app.ts/App.tsx/OpenAPI/inventário ao adicionar rotas.

## Task5 — Convites e ciclo de identidade

- Tokens opacos hash, finalidade, TTL e consumo único atômico; desabilitar entrada por senha até aceite quando aplicável.
- Outbox de e-mail durável na mesma transação do convite; entrega após commit. SMTP de teste, sem enviar e-mail real sem recursos autorizados.
- Recuperação de senha revoga sessões, exige resposta genérica, rate limit e não permite enumeração.
- E-mail já existente vinculado explicitamente, nunca senha redefinida implicitamente.

## Gates

Por tarefa: RED observado quando houver implementação nova, GREEN focalizado, typecheck e integrações reais afetadas. Revisão independente antes da próxima tarefa dependente. Por lote: suíte geral, build, audit high e diff check. Não marcar entrega completa antes dos fluxos reais previstos no plano superior.
