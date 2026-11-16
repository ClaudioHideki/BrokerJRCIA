<!-- jrc-operational-init:v1 -->
# Backlog operacional — Broker JRC

## Em progresso (WIP)

- [ ] **RETENTION-20261116:** Antes de promover a migration LIVE, proteger os caminhos de hard delete contra remoção parcial de objetos com recibos/KEEP. Preflight antes do enqueue e antes da limpeza em lote; remoção de conexão preserva histórico, expurgo permanece separado. Não apagar provas nem usar CASCADE. Nenhuma exclusão foi executada.

- [ ] **RELEASE-20261114:** Validar e promover a candidata com ACK histórico TEXT corrigido, mantendo captura desabilitada; atualizar main/imagens e verificar schema/containers no Dokploy. Ver CONTINUE-AQUI.md; implantação ainda não comprovada.

Nenhuma execução funcional é iniciada por este bootstrap. As frentes já em andamento permanecem nos planos/checkpoints existentes.

## A fazer (To Do)

- [ ] **DOC-01:** Revisar os termos de [glossary.md](docs/domain/glossary.md) com o responsável pelo domínio.
- [ ] **DOC-02:** Conferir [system-overview.md](docs/architecture/system-overview.md) e as versões com o ambiente efetivo quando houver acesso autorizado.
- [ ] **OPS-01:** Homologar ownership, captura live/histórica e custódia sem ativar produção por inferência.
- [ ] **OPS-02:** Conferir CI, imagens e runtime separadamente; não fazer replay cego de UNKNOWN.

## Concluído (Done)

- [x] **DELIVERY-20261116 — candidata e testes:** Broker e LAB2 validados no GitHub sem Docker local. E2E `43957172112`: cinco suítes/seis cenários aprovados em Broker `e26e5f7` + LAB2 `982f1541`. CI ampla do código produtivo Broker `da899085` aprovada em `43954196859`; deltas posteriores até `e26e5f7` são somente testes/relatório. CI LAB2 completa `43946749039`, incluindo frontend. Relatório: docs/implementation/whatsapp-delivery-reliability-20261116.md. Produção, main, imagens publicadas e aceite físico não fazem parte desta conclusão.

- [x] **BOOTSTRAP-01:** Identidade, stack, natureza Brownfield e fontes locais registradas.
- [x] **BOOTSTRAP-02:** Estrutura INIT, domínio, arquitetura e ADR organizados sem apagar conteúdo anterior.

## Como manter

Uma tarefa deve registrar problema, escopo, critério de aceite, evidência/arquivo e limite. Só mover para Concluído com a prova correspondente; não converter publicação de imagem em aceite operacional.
