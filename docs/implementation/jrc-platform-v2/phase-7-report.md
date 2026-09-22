# Fase 7 — Integrações seguras e importação

Data: 2026-09-21  
Branch: `codex/jrc-platform-v2-phase7-integrations-20260921`

## Resultado

O Automation Runtime v2 passou a executar integrações externas por uma camada isolada do worker de mensagens. A entrega inclui cofre de credenciais, HTTP seguro, webhooks autenticados, transformações de dados, SQL somente leitura, código QuickJS isolado, adaptador de IA, subflows versionados e importação assistida de artefatos JRC, n8n e Typebot.

## Banco de dados

A migração `0027_automation_integrations.sql` cria:

- credenciais criptografadas e versionadas;
- webhooks com token armazenado somente como hash;
- artefatos e relatórios de importação;
- auditoria sanitizada das operações de entrada e saída;
- vínculos entre execuções pai e subflows;
- suporte a esperas e outbox dos tipos HTTP, SQL, código e IA;
- políticas RLS, grants e resolução segura de webhooks.

## Cofre de credenciais

- Criptografia autenticada com chave versionada e AAD contendo organização, tipo, ID e versão.
- Criação, consulta de metadados, rotação, revogação e teste de credenciais.
- Segredos nunca são devolvidos pela API ou persistidos no grafo.
- Referências usam apenas `credentialId`.
- Testes de conexão SQL e IA utilizam o segredo dentro da camada de execução.

## Integrações

### HTTP

- somente HTTPS;
- bloqueio de loopback, redes privadas, metadados de nuvem e DNS rebinding;
- DNS pinning, limite de três redirecionamentos e remoção de autenticação em mudança de origem;
- timeout e limites de corpo e resposta;
- repetição automática apenas para GET, no máximo duas vezes.

### Webhooks

- token exibido apenas na criação e persistido como SHA-256;
- assinatura HMAC e timestamp opcionais;
- proteção contra replay por chave idempotente;
- limite de 256 KB;
- URL com token redigida nos logs.

### SQL

- PostgreSQL e MySQL com TLS;
- parâmetros vinculados, timeout, limite de linhas e transação somente leitura;
- comandos de escrita são recusados antes da conexão.

### Código seguro

- execução em QuickJS WASM com limite de tempo e memória;
- sem acesso a rede, sistema de arquivos, variáveis de ambiente ou imports do host;
- serviço de sandbox isolado no Compose, com filesystem somente leitura, capabilities removidas e limites de processo, memória e CPU.

### IA

- operações Generate, Classify, Extract, Summarize e Agent;
- adaptador neutro de provedor e credencial resolvida pelo cofre;
- ferramentas limitadas por allowlist;
- auditoria registra apenas provedor, modelo, uso, custo, latência e resultado sanitizados.

## Runtime e worker

- Worker de I/O dedicado, separado do worker de mensagens.
- Efeitos externos entram em outbox antes da execução.
- Retomada idempotente da automação após o resultado.
- Subflows usam versão fixa, contratos de entrada e saída, bloqueio de recursão, timeout e correlation IDs.
- Transformações seguras: Set, Rename, Pick, Merge, Map, Filter, JSON Parse, JSON Stringify e Safe Expression.

## Importação

- Importação de JSON JRC, n8n e Typebot para um rascunho revisável.
- Relatório por node com classificação exata, parcial ou não suportada.
- Credenciais e tokens são removidos do material convertido.
- O artefato original fica criptografado para auditoria.
- A importação nunca publica automaticamente.

O importador converte somente nodes com equivalentes seguros. Ele não executa workflows n8n arbitrários e não incorpora o editor proprietário do Typebot.

## Configuração operacional

- `AUTOMATION_RUNTIME_V2_ENABLED=true` ativa o runtime novo.
- `CREDENTIAL_VAULT_KEYS_JSON` deve conter o keyring versionado do cofre.
- `AUTOMATION_SANDBOX_TOKEN` deve ser um token forte e exclusivo entre API, worker de I/O e sandbox.
- `AUTOMATION_IO_WORKER_INTERVAL_MS` controla o intervalo do worker dedicado.
- Os serviços `automation-io-worker` e `automation-sandbox` devem subir junto com API, web, worker de mensagens, PostgreSQL e Redis.

## Validação

- `npm run typecheck`: aprovado.
- `npm run build`: aprovado.
- `npm run openapi:generate`: aprovado.
- `npm run security:contracts`: aprovado.
- Auditoria dos contratos de segurança: 3 arquivos e 26 testes aprovados.
- Testes focados da Fase 7: 9 arquivos e 33 testes aprovados.
- `npm audit --audit-level=high`: zero vulnerabilidades conhecidas.
- Suíte completa: 178 arquivos e 1.187 testes aprovados.
- `git diff --check`: aprovado.

## Limites e riscos conhecidos

- Escrita SQL permanece desabilitada.
- O Agent pode produzir chamadas de ferramentas autorizadas; não executa ferramentas fora da allowlist.
- Typebot e n8n são convertidos para o modelo seguro do Broker, sem execução arbitrária do motor original.
- Homologações reais com Meta, Chatwoot/JRC Conversas e provedores de IA dependem de credenciais e ambiente autorizados e serão tratadas na Fase 10.
- Não houve deploy ou alteração no servidor de produção.
