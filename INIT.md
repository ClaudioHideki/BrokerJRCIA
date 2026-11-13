<!-- jrc-operational-init:v1 -->
# INIT — Segundo Cérebro e Governança Operacional

Projeto configurado: **Broker JRC — Flow por caixa LAB**. Natureza: **Brownfield**. A estrutura foi preenchida com fontes locais em 2026-11-13; não substitui planos ou regras anteriores.

## Estrutura

```text
.agents/rules/operational-governance.md
AGENTS.md
ROADMAP.md
TASKS.md
docs/domain/glossary.md
docs/domain/business-rules.md
docs/domain/personas.md
docs/architecture/system-overview.md
docs/architecture/data-model.md
docs/architecture/repository-context-init-v1.json
docs/adr/README.md
docs/adr/0000-template.md
```

## Criação segura em outro projeto

Não usar New-Item -Force em arquivos existentes: isso pode truncar conteúdo. Diretórios podem ser criados com Force; arquivos só se ausentes.

```powershell
New-Item -ItemType Directory -Force -Path .agents/rules, docs/domain, docs/architecture, docs/adr
@('AGENTS.md', 'ROADMAP.md', 'TASKS.md',
  'docs/domain/glossary.md', 'docs/domain/business-rules.md', 'docs/domain/personas.md',
  'docs/architecture/system-overview.md', 'docs/architecture/data-model.md',
  'docs/adr/README.md', 'docs/adr/0000-template.md') | ForEach-Object {
    if (-not (Test-Path -LiteralPath $_)) { New-Item -ItemType File -Path $_ }
}
```

Preencher nome, descrição, stack e natureza do novo projeto. Conferir arquivos/regras anteriores e criar uma ADR de adoção. Em Bash, mkdir -p e touch não devem ser substituídos por redirecionamentos que apaguem conteúdo.

## Manutenção e commit

Conferir o diff, os links, os arquivos preparados e os testes exigidos por AGENTS antes de versionar. Usar git add -- seguido apenas dos caminhos documentais revisados e então git commit -m "docs: bootstrap repo operational second brain". Não adicionar fontes, dados privados, outputs ou sub-repositórios por associação.

Este guia não faz push, merge, deploy, configuração de ambiente ou execução de serviços.
