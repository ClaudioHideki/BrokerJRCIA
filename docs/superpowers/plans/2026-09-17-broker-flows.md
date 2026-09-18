# JRC Flows no Broker

**Retomado pelo pedido de 18/09/2026:** seguir `2026-09-18-broker-omnichannel.md` nesta worktree. O protótipo original e a release anterior permanecem preservados nas respectivas branches.

Escopo confirmado pelo usuário em 17/09: construtor próprio com identidade JRC, login da empresa, instâncias e vínculo Chatwoot/JRC existentes. JSON descreve fluxos; n8n/Typebot não são dependências obrigatórias. Não declarar paridade universal.

Base isolada: ce878f8, branch codex/broker-flows-20260917. Nenhuma produção, commit ou atualização da imagem Chatwoot cliente.

## Implementação

1. RED: grafo, validação de publicação, execução por turnos e importação explícita de incompatibilidades.
2. Persistir rascunhos, versões imutáveis, sessões, vínculos e execuções com RLS. Permissão por organização concedida somente pela administração da plataforma.
3. Integrar ao claim/outbox existentes. Uma automação por conversa; humano/suspensão prevalecem. Preservar integração Typebot existente sem converter configurações silenciosamente.
4. Canvas, biblioteca, formulário dos nós, importação/exportação, teste, publicação por canal e histórico no Broker.
5. Testar API, UI, PostgreSQL real, duas empresas, reinício, pausa humana e fila de respostas. Expor laboratório isolado, com provedor simulado identificado.

O frontend do Broker é React. Reaproveitar formato e comportamento do JRC Flows, mantendo a interface no portal e a autorização no backend. Não publicar nós meramente visuais; tipos ainda não suportados devem bloquear publicação e declarar a incompatibilidade.

## Evidência

Registrar resultados RED/GREEN e limites externos em docs/validation/2026-09-17-broker-flows.md.
