<!-- jrc-operational-init:v1 -->
# Governança operacional — Broker JRC

Esta regra é referenciada por AGENTS.md. A pasta .agents/rules não é tratada como automação; a leitura segue as instruções do projeto.

- Preservar as regras específicas preexistentes do projeto e os trabalhos concorrentes.
- Separar código implementado, teste local, CI, imagem publicada, implantação e aceite operacional.
- Registrar decisões relevantes em ADR e atualizar TASKS/ROADMAP ao encerrar um incremento.
- Não colocar segredos, payloads de clientes, arquivos privados ou sessões nos documentos ou commits.
- Aplicar mudanças no repositório real escolhido; não adicionar uma pasta de coordenação inteira ao Git.

- Antes de editar, ler AGENTS, README/checkpoint, ROADMAP, TASKS, domínio e a decisão relevante.
- Usar TDD nas alterações funcionais quando a regra vigente o exigir; para documentação, conferir links, escopo e preservação.
- Registrar problema, critério de aceite, evidência e limitações; evitar repetir inventários completos sem necessidade.
- Seguir os testes e gates específicos já existentes. Não executar comandos agregados que incluam operações fora da tarefa.
- Usar staging por arquivo. Preservar o índice e alterações concorrentes; não usar git add . em raízes de coordenação.
- Atualizar o contexto ao fechar o incremento, preservando histórico de decisões.
