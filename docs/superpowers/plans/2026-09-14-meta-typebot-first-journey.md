# Meta e Typebot: primeiro percurso funcional

> Execução: superpowers:subagent-driven-development, TDD e revisão. Autorização do usuário em 14/09/2026 permite implementação local; proíbe commit, push, PR, merge e produção.

**Objetivo:** canal → template → envio → recebimento → conversa com Typebot no painel JRC.
**Arquitetura:** preservar monólito, autenticação, RLS e console. Conectores HTTP traduzem contratos externos; persistência inbox/outbox controla processamento. Segredos apenas no servidor. Nenhuma chamada externa dentro de transação.
**Stack:** TypeScript strict, Node 24, Fastify, PostgreSQL/Drizzle, React/Vite, Zod, Vitest.
**Spec:** `../specs/2026-09-06-complete-broker-design.md`, ampliada pelo pedido fornecido em 14/09/2026 para Meta, campanhas e conector Typebot.

## Base e decisões

- Base Git: `159ddfc18ed110957849e43e1825ef6c31ca3cd3`, backend publicado mais completo entre as branches encontradas. Console restaurada do ZIP sem substituir upstream.
- Branch: `codex/phase-2-console-meta-automations`. Diretório isolado `broker-phase-2`.
- Node instalado: 24.16.0; projeto exige 24.19.0. Registrar discrepância nos resultados; não alterar requisito silenciosamente.
- Typebot: conector de API e edição externa inicialmente. Editor incorporado depende de licença validada.
- Meta: versão Graph explicitamente configurada, sem declarar onboarding ou homologação real aprovados por doubles.
- Preservar os recursos Baileys existentes. Evolution/Ligo são referências, não contratos públicos da JRC.

## Tarefas e critérios

### 1. Conector Typebot

Criar `packages/providers/src/typebot/client.ts` e testes correspondentes. Interface: `TypebotClient.startChat(publicId, text?)` e `continueChat(sessionId, text)`, retornando sessionId, textos e incompatibilidades explícitas. Configuração exclusivamente de servidor, origin HTTPS permitido, sem redirects, timeout e limite de resposta. Rejeitar respostas inválidas sem vazar conteúdo. Testar contrato HTTP, ordem de textos, 404 de sessão, timeout e destinos hostis. Primeiro observar RED, depois GREEN. Não executar ações de client-side fornecidas pelo fluxo.

### 2. Cliente Meta e assinatura

Criar `packages/providers/src/meta/cloud-client.ts`, `webhook.ts` e testes. Interface: cliente configurado com versão/token/phoneNumberId/WABA; enviar texto/template e listar templates. Aceitação retorna ID upstream; nunca equivale a entrega. POST incerto retorna erro canônico UNKNOWN sem retry. Assinatura HMAC SHA-256 sobre Buffer original; validação constante e estrita. Não modificar o esqueleto de onboarding como se estivesse funcional.

### 3. Persistência e processamento

Criar módulo de mensageria, migration e repositório com vínculo tenant, canal, mensagem, inbox/outbox e sessão de bot. Unicidade por chave de idempotência e evento. Claims com lease; envio incerto não reenvia automaticamente. Revalidar pausa humana antes de respostas. Testar isolamento, rollback, concorrência, recuperação e transições de estado em PostgreSQL isolado. Nenhum processamento puramente em memória será apresentado como durável.

### 4. API e console

Integrar rotas autenticadas e contratos Zod para templates, mensagens, conversas e bots. Todas as ações derivam organização da identidade; VIEWER somente lê. UI usa sessão e cliente HTTP existentes. Dados de demonstração somente em modo explicitamente identificado. Testar HTTP/RBAC e UI, atualizar OpenAPI. Nenhuma ação ausente aparece como operacional.

### 5. Fechamento do incremento

Executar testes focalizados, suíte, typecheck, build, integração e E2E aplicáveis; registrar impedimentos com comandos. Revisar código novo e corrigir achados. Documentar matriz de recursos, guia local, Meta/Typebot, doubles e pendências externas. Não chamar plataforma completa enquanto faltarem módulos do pedido.

## Progresso

- [x] Inspeção dos arquivos e referência remota; branch isolada e restauração da console.
- [x] Baseline executável e validada.
- [x] Conector Typebot validado localmente.
- [x] Cliente Meta e assinatura validados localmente.
- [x] Persistência, worker, API e console do primeiro percurso.
- [x] Revisão, testes integrados e documentação do resultado.
