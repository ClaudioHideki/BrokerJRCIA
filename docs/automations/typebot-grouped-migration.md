# Migração de exports agrupados Typebot para rascunho nativo

O conversor preserva texto de parágrafos richText, itens em block.items, nomes de variáveis definidos por ID, início por evento e saídas referenciadas por item. O retorno pode apontar ao primeiro bloco de um grupo ou a um bloco específico, sem repetir mensagens anteriores. A escolha numérica é traduzida ao rótulo da opção quando a origem salva uma variável, preservando mensagens posteriores que exibem departamento/atendente.

Somente referências atuais de eventos, blocos e itens são executáveis. Arestas históricas não referenciadas não criam opções novas. Referências ausentes, ambíguas ou com origem/destino divergente são recusadas. O resultado continua em rascunho, com revisão obrigatória e os limites nativos de grafo.

Webhooks e demais ações não suportadas permanecem inertes no ramo correspondente. URL, body e credenciais não são copiados para configuração executável. Substitua essas ações por blocos nativos e selecione destinos autorizados antes de publicar. A migração não chama Typebot, n8n ou Bridge durante a execução do Flow.

O export OIA Global/Teste foi analisado somente localmente. Seus 38 blocos resultaram em 83 nós, 106 conexões, 44 saídas de menu e oito ações externas ainda bloqueadas. Não há certificação do fluxo produtivo ou da CRF. O payload de transferência de origem informa departamento; atribuição ao agente exato exige validar a regra e o catálogo reais. O original, com dados de negócio/teste, não integra o repositório.

Regressão sintética: apps/api/tests/unit/automation-typebot-converter.test.ts. Cinco testes observaram RED antes da mudança e GREEN depois; a suíte existente do importador permaneceu verde. A revisão independente acrescentou um sexto caso RED para grupo sem ID em um grafo explícito: essa entrada agora é recusada em vez de cair no importador linear. Publicação e homologação integrada dependem dos gates da revisão final, não deste registro de desenvolvimento.
