# JRC Platform V2 — conclusão das fases 9 e 10

## Objetivo

Consolidar o código publicado e os snapshots de 22/09/2026 em uma única linha de desenvolvimento, concluir o plano existente a partir da Fase 9 e entregar um Broker JRC próprio, SaaS multitenant, operável em produção pelo GitHub Container Registry e Dokploy.

Evolution, Ligo, Typebot e n8n são referências funcionais e de experiência. O produto, o editor visual e o runtime de automação pertencem à JRC. Typebot e n8n são fontes de importação; não são dependências do runtime principal.

## Fonte e estratégia de consolidação

A branch remota mais avançada, `codex/broker-omnichannel-20260918`, é a base histórica porque contém 17 commits além da `main` e inclui a linha de release anterior. O snapshot `BROKER_JRC_COMPLETO_ESTADO_ATUAL_20260922.zip` contém trabalho posterior, incluindo as migrations 0026 a 0029 e a Fase 9 incompleta.

O trabalho ocorrerá em `codex/jrc-platform-v2-complete`. A consolidação preservará o histórico remoto, aplicará o delta do snapshot com revisão de conflitos e manterá a `main` protegida até a aprovação integral. Não haverá cópia cega do ZIP sobre a `main`.

## Sequência obrigatória

### Marco 1 — Fase 9 e integridade

1. Importar o delta do snapshot sobre a branch de consolidação.
2. Concluir a migração de automações legadas e seu cutover/rollback.
3. Validar a migration 0029 em PostgreSQL real, inclusive upgrade de base com dados.
4. Atualizar OpenAPI, contratos, documentação e testes.
5. Restaurar LICENSE, NOTICE e TRADEMARKS do upstream Evolution.
6. Manter um único manifesto SHA-256 autoritativo.
7. Tornar os artefatos de auditoria reproduzíveis no checkout Git e no pacote de transferência.
8. Encerrar o marco somente com typecheck, build e suíte integral verdes.

### Marco 2 — segurança e multitenancy

1. Exigir senha e TOTP para administradores JRC em produção.
2. Manter papéis globais separados dos papéis da organização.
3. Aplicar suspensão a login, API keys, novos envios, campanhas, provisionamento e claims.
4. Preservar pendências e eventos recebidos durante suspensão.
5. Distribuir trabalho com rodízio, orçamento e timeout por organização.
6. Tornar toda ação de suporte autorizada, motivada, temporária e auditada.
7. Proteger segredos no servidor e nunca retornar valores integrais.
8. Manter RLS forçada e runtime comum sem `BYPASSRLS`.

### Marco 3 — canais e integrações

#### Meta oficial

O aplicativo Meta pertence à JRC. O cliente autoriza WABA e telefone pelo Embedded Signup. O sistema cobre onboarding, readiness, webhooks, mensagens, mídia, templates, revogação externa idempotente e reconciliação. Pendências de revisão, pagamento, propriedade ou permissão aparecem como ações guiadas.

#### Baileys/Evolution

Cada sessão é vinculada à organização, canal e instância. QR e pairing code são temporários e restritos. O Broker controla provisionamento, status, logout, reconexão, novo pareamento e auditoria. A fronteira com o motor deve impedir que credencial global exposta permita operações tenant sem autorização do Broker.

#### Integrações de automação

Chatwoot/JRC Conversas, OpenAI, Dify, Flowise e endpoints HTTP são conectores opcionais do runtime JRC. Typebot e n8n entram por importação com relatório de compatibilidade. JSON externo nunca é executado arbitrariamente.

### Marco 4 — produto e UX

O portal da empresa terá:

- dashboard operacional;
- conexões e ciclo completo de canais;
- contatos, conversas, inbox e transferência humana;
- campanhas, segmentos, agenda, limites e relatórios;
- Automation Studio JRC com biblioteca de nós, credenciais selecionáveis, validação, simulação, publicação, versões, ativação e rollback;
- templates Meta, mídia e mensagens interativas;
- chaves de API, webhooks, integrações e logs;
- plano, consumo e usuários.

O painel JRC terá:

- empresas, situação, responsáveis e usuários;
- planos, limites e consumo;
- conexões Meta e Baileys;
- mensagens, filas, webhooks e falhas;
- ações de suporte autorizadas e auditadas;
- saúde global, incidentes e trilha de auditoria.

Formulários usarão componentes estruturados, sem entrada JSON por `window.prompt`. Estados vazios explicarão a próxima ação. Erros exibirão causa, correlação e ação segura. A interface será responsiva e acessível por teclado.

## Automation Studio JRC

O editor e o runtime são subsistemas próprios:

1. O editor produz uma definição versionada no esquema JRC.
2. O validador impede publicação de grafos inválidos, credenciais ausentes e ciclos proibidos.
3. O publicador cria versão imutável e define bindings de gatilho.
4. O runtime executa passos duráveis, idempotentes e retomáveis.
5. Esperas e agendamentos são persistidos; nenhum processo depende de memória local.
6. Cada execução registra entradas saneadas, transições, tentativas, saída e erro.
7. Segredos são resolvidos no momento da execução e nunca incorporados à definição.
8. Importadores convertem nós conhecidos de Typebot/n8n e produzem avisos para os demais.

## Modelo de dados e isolamento

Toda entidade operacional inclui `organization_id` e é protegida por RLS: canais, contatos, conversas, mensagens, mídia, campanhas, segmentos, fluxos, versões, bindings, execuções, credenciais, webhooks, chaves, arquivos e eventos.

Sessões de provider usam identidade opaca derivada de organização, canal e instância. Cache, filas e locks usam namespace de organização. Arquivos usam armazenamento privado e AAD de organização. Nenhuma API aceita um identificador de organização do cliente como autoridade; a organização efetiva vem da sessão ou chave autenticada.

## Fluxo de mensagens

```text
provider
  -> validação de assinatura
  -> resolução de organização e canal
  -> persistência idempotente
  -> fila justa da organização
  -> gatilho do Automation Studio
  -> execução durável
  -> outbox
  -> provider de saída
  -> status, métricas e auditoria
```

Falhas transitórias usam retry com backoff e dead letter. Falhas permanentes expõem código acionável. Idempotência cobre ingestão, automação e envio.

## Suspensão, retenção e exclusão

Suspensão impede novas operações de saída e pausa pendências sem apagar dados. Eventos recebidos continuam validados e armazenados segundo a política do plano. Reativação retoma pendências dentro dos limites vigentes.

Exclusão é um processo auditado: solicitação, carência, exportação opcional, revogação de providers, eliminação de segredos, remoção de dados e certificado final. Retenção é configurada por classe de dado e por obrigação operacional.

## Produção e cadeia de entrega

1. Builds usam Node 24.19.0 e lockfile.
2. Imagens e Actions críticas são fixadas por digest/SHA.
3. CI executa typecheck, build, testes, migrations, contratos, segurança e Docker smoke.
4. A imagem é publicada no GHCR por commit e versão, com digest, SBOM, provenance e assinatura.
5. Dokploy promove a mesma imagem por digest entre homologação e produção.
6. Serviços têm healthcheck, readiness e limites de recursos.
7. Migrações são executadas por job único antes da aplicação.
8. Rollback da aplicação não altera silenciosamente o banco; mudanças destrutivas seguem expand/migrate/contract.

## Backup e recuperação

Backups cifrados abrangem PostgreSQL, configuração necessária, segredos protegidos, mídia e estado operacional dos providers quando suportado. Redis não é fonte exclusiva de verdade. Há retenção, cópia externa, verificação de integridade e restore drill periódico. RPO e RTO são medidos e documentados.

## Estratégia de testes

- Unitários para regras, contratos, importadores e adapters.
- Integração em PostgreSQL/Redis reais para RLS, migrations, filas e suspensão.
- Contratos de providers com fakes determinísticos.
- E2E de painel JRC e duas empresas.
- Testes negativos de isolamento de dados, arquivos, cache, APIs e providers.
- Testes de fairness e limites sob carga.
- Homologação real separada para Meta, Baileys, Chatwoot e conectores de IA.
- Restore drill e smoke da imagem por digest.

## Critérios de aceite

1. Fases 9 e 10 documentadas e integralmente verdes.
2. Duas empresas não acessam dados, arquivos, filas, conexões ou segredos entre si.
3. Administrador tenant não acessa administração JRC.
4. Suporte executa apenas ações permitidas e auditadas.
5. Suspensão e limites funcionam na API e nos workers.
6. Fluxo importado é convertido e executado pelo runtime JRC.
7. Meta e Baileys completam envio e recebimento em homologação.
8. Backup restaurado produz ambiente funcional dentro dos objetivos medidos.
9. Imagem assinada é promovida por digest e inicia com healthchecks verdes.
10. Documentação permite instalação, operação, atualização e recuperação sem conhecimento implícito.

## Fora do escopo

- Incorporar código de Typebot, n8n, Ligo ou outros produtos sem licença aprovada.
- Executar Typebot ou n8n como runtime principal.
- Copiar identidade visual ou código proprietário de referências.
- Publicar ou implantar em produção antes da aprovação final.
