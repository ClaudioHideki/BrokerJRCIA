# Plano focal — switch tipado

Spec: `../specs/2026-10-16-flow-typed-switch-design.md`. Execução inline do programa já autorizado, preservando branches candidatas e sem publicação.

- [x] RED de configuração, valores ambíguos, portas obrigatórias e roteamento estrito.
- [x] Contrato/export, definição no catálogo e execução no motor existente, sem alterar condição legada.
- [x] RED/GREEN do editor tipado acessível no FlowCanvas; IDs das saídas estáveis.
- [x] Persistência/publicação/execução sintética e regressões focais, typecheck e revisão focal.
- [x] Registrar evidência, npm test/diff check e commit apenas local.

## Rulings da revisão focal

Dois achados Important reproduzidos antes de corrigir. IDs sequenciais reutilizavam casos removidos, revalidando ligação antiga silenciosamente; novos casos agora recebem ID aleatório estável com 124 bits de entropia. O canvas rejeitava item null ao procurar o nome de uma porta importada; busca agora defensiva e configuração inválida permanece disponível para recuperação explícita. Nenhum caso removido é reconectado automaticamente. GREEN dos dois achados e contrato:24 testes; teste final do canvas com remoção/adicionar/INVALID_PORT:2 aprovados.

O teste de publicação usa somente banco local descartável e verifica ausência de automation_bindings. Não publica nem vincula fluxo em produção. A execução do contrato/motor anterior foi RED15/GREEN15; extensão da visibilidade de portas elevou casos unitários para16.

Fonte do incremento commitado localmente em51dbab1. Pacote do editor instalado apenas na candidata JRC a partir desse commit,198 entradas verificadas. Smoke de navegador GREEN em sete cenários, incluindo switch e zero requisições externas. Manifestos de composição gerados/verificados no JRC. Não houve publicação de imagem ou deploy. Suíte geral e reexecução focal dos arquivos corrigidos registradas no documento de validação, sem afirmar uma rodada geral inteiramente verde após os últimos ajustes.
