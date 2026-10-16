# Flow — decisão por vários valores

Implementação candidata local, ainda sem publicação da atualização consolidada. Nenhuma automação foi criada, publicada, vinculada ou ativada no servidor.

## Como funciona

No catálogo de Automações, o novo bloco **Decidir por vários valores** seleciona uma variável existente e compara seu valor com até20 casos. Cada caso possui nome e tipo explícito: texto, número, sim/não ou nulo. A igualdade é estrita: texto “1” e número1 são casos diferentes. Não há execução de código ou consulta externa.

A saída **Saída padrão** deve estar conectada e recebe valores sem correspondência, variável ausente, objetos e listas. Nulo explícito pode ter caso próprio. Valores iguais do mesmo tipo e IDs de saída duplicados são recusados. Erros de configuração não são convertidos silenciosamente em zero ou em texto.

O operador pode ligar cada caso pelo nome. Renomear mantém sua conexão. Remover um caso preserva a ligação antiga para revisão e impede publicação até corrigir a saída inválida. Adicionar outro caso nunca reaproveita essa identidade. Dados importados inválidos são preservados e exibem recuperação explícita, sem derrubar o canvas.

O bloco usa o mesmo contrato, motor, simulação e FlowCanvas do Broker. Superfícies embutidas que consomem o catálogo de Automações recebem a mesma lógica. Não se criou motor ou módulo JRC paralelo. A condição textual anterior conserva sua semântica. Nenhuma publicação anterior é reescrita.

## Evidência

- RED inicial:15 testes reproduziram ausência do nó no catálogo e do roteamento no motor. GREEN15; extensão de porta estável durante edição inválida adicionou um caso.
- Editor escalar inicial:5 testes aprovados.
- Regressões catálogo/motor/Studio/editor:124 testes aprovados em quatro arquivos, antes dos dois ajustes de revisão.
- PostgreSQL:1 teste cria e publica uma definição sintética, altera o rascunho, executa a versão imutável antiga e verifica ausência de vínculo a caixa. Outra empresa não lê a definição.
- Revisão somente leitura:2 achados Important reproduzidos; corrigidos com identidade não reutilizável e renderização defensiva. GREEN24 testes em três arquivos; extensão final do canvas remove/adiciona caso e mantém INVALID_PORT na ligação antiga:2 testes aprovados.
- TypeScript aprovado após correções da revisão. Build local aprovado; bundle web11 arquivos, nenhuma ocorrência no scanner. Avisos existentes do Rollup/Zod e tamanho do chunk continuam avisos, sem alteração de limites.
- Suíte geral iniciou antes das correções da revisão e terminou com407 arquivos/3147 testes aprovados e4 falhas: os dois achados reproduzidos, a matriz documental ainda sem a linha switch e uma fixture temporária Git que não permaneceu reconhecida como repositório. Após corrigir editor/documentação, os quatro arquivos passaram juntos:51 testes, com o caminho Git do runtime configurado. Não se declara uma nova suíte geral integralmente verde após esses ajustes.
- Pacotes compilados:1 teste aprovado e1 ignorado porque exige APP_DATABASE_URL/AUTH_DATABASE_URL/REDIS_URL. O build foi refeito pelo próprio comando. O skip não comprova inicialização com esses serviços.
- Editor embutido: teste de navegador local na candidata JRC antiga reproduziu ausência do botão do switch, preservando os demais cenários. É necessário reinstalar o pacote a partir deste fonte commitado e verificar sua procedência no JRC candidato; isso não altera produção.

Atualização concluída do pacote candidato:198 inputs de build verificados contra o commit51dbab1f26120a0235f7e6b92ac37c1261573ba1; sourceCommitted:true. Smoke de navegador exclusivamente local GREEN nos sete cenários shared-editor, named-box, private-note-draft, typed-switch, publish-scope, shadow-css e session-close, sem requisições externas. Manifestos de composição JRC gerados e verificados. Detalhes no repositório candidato JRC, `docs/validation/2026-10-16-shared-editor-switch.md`. O Flow Ruby legado conserva seu formato distinto; não foi convertido automaticamente.

## Limites

Não é agente IA, construtor de consultas ERP ou switch com expressões arbitrárias. É uma decisão determinística sobre dados já disponíveis no fluxo. Um teste sintético não homologa o chatbot na central ou no WhatsApp. Publicação de imagem e teste no novo servidor ficam para o corte consolidado autorizado. Sem migration, Compose, ENV ou credencial novos neste incremento.
