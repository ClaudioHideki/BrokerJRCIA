# Operação SaaS multitenant JRC

> Execução autorizada pelo complemento obrigatório do usuário em 14/09/2026. Usar subagent-driven-development, TDD e revisão. Sem commit, push, PR, publicação ou produção. Preservar o incremento Meta/Typebot e Baileys existente.

## Arquitetura e decisões

Administração global e portal usam contextos de identidade distintos. Papéis de organização nunca promovem usuário à plataforma. Administração requer senha e TOTP, sessão curta revogável e credencial PostgreSQL administrativa dedicada sem BYPASSRLS; tabelas tenant permanecem com RLS. Operações de suporte são uma lista explícita, com motivo obrigatório e auditoria durável, sem impersonação genérica nem leitura de conteúdo/segredos.

Planos definem limites de instâncias, usuários, envios por dia e pendências. Enforcement transacional no banco protege concorrência e workers. Suspensão preserva dados e eventos recebidos, bloqueia novos envios/pareamentos e pausa itens ainda não enviados; envios já em voo mantêm seu resultado, sem reenvio cego. Agendamento percorre organizações com trabalho limitado por rodada.

Meta usa aplicativo da JRC, Embedded Signup com estado de autorização vinculado à organização/usuário e validado no servidor, tokens protegidos no servidor, ativos validados pela Graph API. Onboarding exibe pendências e revogação; não transfere propriedade nem simula aprovação/pagamento. Testes externos usam doubles, homologação real exige configuração externa.

Interface separa /jrc do portal, informa estado, ações permitidas, falhas recuperáveis e feedback. Não apresenta botão sem efeito como implementado. Infra inclui imagem API/worker, frontend com proxy de mesma origem, migração explícita, variáveis sem segredos reais, volumes e runbook Dokploy/GHCR. Workflow preparado localmente, não disparado.

## Tarefas

- [x] Administração: migration 0010, identidade/MFA/sessões, empresas/responsáveis/usuários/planos, suporte autorizado/auditado, monitoramento e testes com duas organizações.
- [x] Enforcement: migration 0011, quotas/suspensão para API e workers, isolamento das superfícies existentes, fairness e regressões PostgreSQL.
- [x] Meta SaaS: migration 0012, autorização Embedded Signup, credenciais/ativos e revogação, testes e contrato para UI.
- [x] UX: login JRC separado, empresas e operação, portal e autorização Meta, feedback/acessibilidade, testes UI e jornadas integradas.
- [x] Infra: Compose/env/Dockerfiles/workflow GHCR, backup/recuperação/retenção/exclusão por organização, validação local.
- [x] Revisão e fechamento: corrigir achados, suíte unitária/integração/build/E2E aplicável, evidências e relatório atualizado.

## Regras de coordenação

Cada implementador possui apenas seus arquivos. Mudanças em app.ts, schema.ts, journal e package.json são integradas pelo controlador para evitar colisões. Migration 0010 é da administração, 0011 enforcement, 0012 Meta. Relatos em docs/operations/saas-<frente>.md contêm contratos, execução dos testes e limitações. Não apagar workspace: sem commits, ele é a entrega.
