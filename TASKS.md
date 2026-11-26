<!-- jrc-operational-init:v1 -->
# Backlog operacional — Broker JRC

## Incremento de 24/11/2026

- [x] Implementar navegação opcional 0/voltar com histórico do caminho e contexto, sem renumerar opções.
- [x] Implementar novo ciclo após resolução JRC comprovada, sem envio ou replay, preservando humanos e tenants.
- [ ] Validar CI PostgreSQL do SHA final, publicar imagens e conferir runtime antes da ativação seletiva.
- [ ] Homologar novo atendimento e retorno no WhatsApp com nova mensagem real.

ADR0006 registra as políticas e limites.

## Estado vigente — reparo outbound de 17/11/2026

- [ ] **MEDIA-AUDIT-20261117:** Pesquisa confrontada com código/runtime: MIME Opus comprovado; histórico desativado, catálogo vencido e projeções bloqueadas. Ver docs/implementation/media-investigation-20261117.md. Candidata isolada preserva main f6b9ce0; publicação/aceite continuam pendentes.
- [ ] **CI-SECURITY-20261117:** Falha do audit reproduzida; backport local do picomatch com RED/GREEN, licença e gate preservado. ADR0005; nova CI do SHA final necessária.

- [x] **OUTBOUND-20261117:** Intenção humana comprovada e retorno de status multipart corrigidos por TDD; CI/E2E/imagem API e deploy DONE. Main4919ace preserva a base anterior. [Recibo e limites](docs/implementation/outbound-repair-20261117-result.md).
- [x] **OUTBOUND-REAL-20261117:** Intenção original e novo texto chegaram; imagem e PDF sintéticos READ. UNKNOWN antigo preservado, sem replay manual.
- [ ] **AUDIO-20261117:** Ogg sintético rejeitado MEDIA_TYPE_UNSUPPORTED antes de providerID. Identificar MIME HTTP real, reproduzir RED e corrigir; segundo contato autorizado ainda sem teste. Navegador travou durante diagnóstico. Não considerar mídia totalmente aceita.
- [ ] **RUNTIME-20261117:** Reter inspeção final das nove réplicas e operational-status; deploy DONE e containers engine/PG/Redis/web preservados já observados.

## Estado vigente — publicação de 16/11/2026

- [x] **RELEASE-20261116:** CI final, E2E Broker/LAB2, imagens e deploy dos dois produtos concluídos. Runtime e schema conferidos; [evidências e digests](docs/implementation/release-20261116-result.md).
- [x] **RETENTION-20261116:** Proteção de histórico/recibos implementada, testada e publicada; migração0095 aplicada sem expurgo.
- [x] **FLOW-20261116:** Paginação do seletor corrigida, regressão aprovada e19 caixas carregadas na interface publicada; nenhuma automação ativada.
- [ ] **ACCEPTANCE-20261116:** Conferir entrega física e conciliar grupos, distribuição, histórico e mídia antiga. Capability200 e Minhas25→34 não provam completude do WhatsApp.
- [ ] **META-20261116:** Separar consulta opcional de faturamento da prontidão; concluir vínculo do canal existente com JRC. Autorização Meta válida na inspeção; não pedir novo login por esse erro.

## Registro anterior da preparação (histórico)

- [ ] **RELEASE-20261116:** Guard de retenção `0095` e proteção LAB2 implementados após RED em CI. Candidata LAB2 incorpora filtro de segmento e popup de propostas já validados; Call Center WIP preservado fora desta promoção. Revalidar GREEN, E2E, imagens e runtime antes de concluir. Publicação e deploy Grupo JRC/Broker autorizados; sem backup/dump/restore ou envio real.
- [ ] **FLOW-20261116:** Auditoria autenticada e simulação sem envio realizadas; corrigido limite de paginação 200→100 no painel de vínculos. Regressão local aprovada. Ver `docs/implementation/flow-audit-20261116.md`; publicação de automações não realizada.

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

- Entrega independente de mensagens individuais novas com histórico incerto. Implementação e teste de regressão em PostgreSQL registrados na ADR 0007 e em `chatwoot-live-receipts.test.ts`. O aceite operacional exige conferir uma entrada real única na conversa vinculada.

Uma tarefa deve registrar problema, escopo, critério de aceite, evidência/arquivo e limite. Só mover para Concluído com a prova correspondente; não converter publicação de imagem em aceite operacional.
