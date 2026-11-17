<!-- jrc-operational-init:v1 -->
# Regras de negócio — Broker JRC

Estas regras documentam o escopo conhecido e preservam as decisões específicas anteriores; não ativam comportamentos no produto.

- Isolar tenant, permissões, IDs e credenciais em todos os contratos.
- Confirmar persistência antes de ACK; preservar idempotência, retry e ordenação.
- Manter KEEP/custódia de mídia até comprovação dos recibos; não reenviar operações UNKNOWN por inferência.
- Não substituir ou ativar a engine produtiva a partir de um teste sintético.

## Regras de manutenção

- Preservar as regras específicas preexistentes do projeto e os trabalhos concorrentes.
- Separar código implementado, teste local, CI, imagem publicada, implantação e aceite operacional.
- Registrar decisões relevantes em ADR e atualizar TASKS/ROADMAP ao encerrar um incremento.
- Não colocar segredos, payloads de clientes, arquivos privados ou sessões nos documentos ou commits.
- Aplicar mudanças no repositório real escolhido; não adicionar uma pasta de coordenação inteira ao Git.

## Fontes de confirmação

- [AGENTS.md](<../../AGENTS.md>)
- [README.md](<../../README.md>)
- [CONTINUE-AQUI.md](<../../CONTINUE-AQUI.md>)
- [package.json](<../../package.json>)
- [apps/api/src/modules](<../../apps/api/src/modules>)
- [apps/web/src](<../../apps/web/src>)
- [infra/dokploy/compose.yaml](<../../infra/dokploy/compose.yaml>)
- [docs/implementation/history-operational-host-20261112.md](<../../docs/implementation/history-operational-host-20261112.md>)
