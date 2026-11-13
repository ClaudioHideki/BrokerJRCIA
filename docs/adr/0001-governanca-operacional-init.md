<!-- jrc-operational-init:v1 -->
# ADR 0001: Segundo Cérebro e Governança Operacional

- **Status:** Aceita
- **Data:** 2026-11-13
- **Autores:** Responsável do projeto JRC e agente executor da documentação.
- **Fonte da decisão:** pedido explícito do usuário para aplicar o guia INIT a todos os projetos.

## Contexto

Broker JRC — Flow por caixa LAB já existe e mantém regras, planos e arquivos anteriores. É necessário organizar continuidade, domínio e arquitetura sem recomeçar o projeto.

## Decisão tomada

Adotar o INIT de forma aditiva: AGENTS, ROADMAP, TASKS, domínio, arquitetura, regra operacional e ADR. Preservar integralmente o conteúdo anterior e preencher o contexto com fontes locais, distinguindo aplicação e coordenação. Usar links e checklists de manutenção; não criar automações ou exigir novos serviços para manter documentação.

## Consequências

- **Positivas:** entrada consistente para pessoas e agentes, decisões rastreáveis e estado explícito.
- **Negativas / riscos:** os documentos exigem atualização; uma fotografia do Git não comprova runtime, deploy ou homologação.
- Esta decisão é documental. Não altera funcionalidades, permissões, infraestrutura, políticas financeiras, engine ou dados.
