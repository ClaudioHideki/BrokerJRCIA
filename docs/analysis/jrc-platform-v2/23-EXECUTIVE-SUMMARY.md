# 23 — Resumo executivo

## Situação

A candidata analisada já possui uma base relevante: multi-tenant, autenticação e auditoria, QR/Evolution, fundações Meta, integrações Chatwoot, Agent Bot, flows versionados, canvas, simulação, publicação e execução. O JRC Conversas complementa essa base com inbox, atendimento humano e um catálogo local mais amplo.

Os erros vistos em produção não indicam necessidade de outro PostgreSQL: o compose já contém PostgreSQL, Redis, Evolution, API, Web e worker. Eles são compatíveis com ambiente/schema/configuração divergentes e contratos ainda parciais. A primeira ação é estabilizar e reconciliar a revisão implantada, migrations e variáveis.

## Produto alvo

O Broker deve oferecer uma fachada única de canais QR e Meta, destinos JRC Conversas/Chatwoot por empresa e um Automation Studio próprio. O Studio importa conceitos e JSON compatíveis de n8n/Typebot, mas executa um modelo seguro e versionado do Broker. Inbox, agentes, conversas e atendimento humano continuam no JRC Conversas.

## Prioridades

1. Corrigir 401/500/503, validar migrations, backup externo e observabilidade.
2. Implantar cofre de credenciais, autorização por tenant/inbox e proteção SSRF/webhooks.
3. Consolidar canais e destinos sem quebrar rotas atuais.
4. Evoluir flows para automações canônicas com runtime durável.
5. Entregar Studio, mídia/interações WhatsApp e Meta homologada.
6. Adicionar integrações/importadores somente após os limites seguros estarem prontos.

## Dez maiores lacunas

1. Ambiente de produção sem reconciliação comprovada de schema/configuração.
2. Console super admin e integração Chatwoot com falhas 500/503 observadas.
3. Reconexão JRC ainda dependente de grant individual e permissões amplas.
4. Meta sem configuração e homologação ponta a ponta.
5. Mídia, interações, contato e localização ausentes do Flow do Broker.
6. Runtime sem waits/delays/checkpoints completos e workers especializados.
7. Cofre de credenciais central ainda ausente.
8. HTTP/SQL/code/IA genéricos ainda sem execução segura canônica.
9. Dois motores de flow coexistem sem owner único definitivo.
10. Backup externo restaurável e observabilidade por execução ainda não comprovados.

## Dez melhores candidatos a reutilização

1. Identidade multi-tenant, memberships, papéis e auditoria do Broker.
2. Provider accounts, instances e adaptador Evolution.
3. Outbox/messaging worker e controles de idempotência existentes.
4. Meta onboarding, webhooks e criptografia já iniciados.
5. Integração Chatwoot, Control API e embed authorization.
6. Flow draft/validate/simulate/publish/version/binding/run.
7. Transporte Agent Bot e migration 0025.
8. Editor React e contratos de nós atuais.
9. Membership de conta/inbox e atendimento humano do JRC Conversas.
10. Conceitos do flow JRC: waits, switch, subflow, HTTP, sandbox e IA.

## Riscos por prioridade

- **P0:** isolamento de tenant, segredo exposto, schema divergente, ausência de backup restaurável, troca silenciosa de identidade QR.
- **P1:** duplicação/perda de mensagem, SSRF, semântica incorreta de importação, falha de homologação Meta, rollback incompatível.
- **P2:** dependência de versão Chatwoot, custo de observabilidade, licença Typebot e crescimento do catálogo.

## Ordem aprovada pelo plano

Baseline → contratos canônicos → conector JRC por membership → Chatwoot externo → canais/Meta → runtime v2 → Studio → integrações seguras → observabilidade → migração legada → hardening.

## Decisões humanas pendentes

Licença/integração Typebot; oferta de nós CRM/Nico; política de retenção; provedor de object storage; SLOs e limites comerciais; permissão de SQL write/code/AI por plano; cronograma de descontinuação do Flow local; e credenciais/configuração do app Meta para homologação.

## Resultado esperado

Ao fim das dez fases, uma empresa cria canal QR ou Meta, escolhe JRC Conversas ou Chatwoot autorizado, constrói/importa uma automação visual, publica uma versão, acompanha cada execução e transfere para humano com isolamento, auditoria e rollback. Super admins enxergam a plataforma inteira; usuários de empresa veem apenas seus recursos; membros de inbox podem consultar e parear sem receber poderes administrativos.

## Critério de “completo”

Uma capacidade só passa de `PARTIAL` para `IMPLEMENTED` depois de contrato, UI, persistência, autorização, observabilidade, teste ponta a ponta e procedimento de rollback aprovados. Configurar variáveis ou exibir um botão não encerra a funcionalidade.
