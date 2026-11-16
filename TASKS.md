<!-- jrc-operational-init:v1 -->
# Backlog operacional — Broker JRC

## Em progresso (WIP)

- [ ] **DELIVERY-20261116:** Código humano/status/concorrência/cursor/mídia/GROUP e receptor LIVE nativo implementados; geral Broker4487/4487 e PG193/193, com deltas focais85/85 e32/32. Executar CI e HTTP E2Es finais no GitHub Actions conforme pedido do usuário, sem forçar Docker local. Migration LAB220261116190000 ainda não produtiva; hard delete/retention e build Linux elegível são gates pré-release. Plano: docs/superpowers/plans/2026-11-16-whatsapp-delivery-reliability.md. Evidências/limites: docs/implementation/whatsapp-delivery-reliability-20261116.md. Candidata de teste autorizada; sem produção/merge/imagens.

- [ ] **RELEASE-20261114:** Validar e promover a candidata com ACK histórico TEXT corrigido, mantendo captura desabilitada; atualizar main/imagens e verificar schema/containers no Dokploy. Ver CONTINUE-AQUI.md; implantação ainda não comprovada.

Nenhuma execução funcional é iniciada por este bootstrap. As frentes já em andamento permanecem nos planos/checkpoints existentes.

## A fazer (To Do)

- [ ] **DOC-01:** Revisar os termos de [glossary.md](docs/domain/glossary.md) com o responsável pelo domínio.
- [ ] **DOC-02:** Conferir [system-overview.md](docs/architecture/system-overview.md) e as versões com o ambiente efetivo quando houver acesso autorizado.
- [ ] **OPS-01:** Homologar ownership, captura live/histórica e custódia sem ativar produção por inferência.
- [ ] **OPS-02:** Conferir CI, imagens e runtime separadamente; não fazer replay cego de UNKNOWN.

## Concluído (Done)

- [x] **BOOTSTRAP-01:** Identidade, stack, natureza Brownfield e fontes locais registradas.
- [x] **BOOTSTRAP-02:** Estrutura INIT, domínio, arquitetura e ADR organizados sem apagar conteúdo anterior.

## Como manter

Uma tarefa deve registrar problema, escopo, critério de aceite, evidência/arquivo e limite. Só mover para Concluído com a prova correspondente; não converter publicação de imagem em aceite operacional.
