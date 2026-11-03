# Correção de imagem com legenda — 03/11/2026

Estado: correção local do contrato de mídia; sem publicação, alteração da engine produtiva ou novo envio real neste incremento. Base executável do Broker: `d1d0f2e6d7812865c39b1250454e238231b720b2`.

Atualização de release, 03/11 às 16h13 Brasília: publicação da correção autorizada pelo usuário. Build e typecheck repetidos com exit0; regressão aprovada no escopo completo autorizado: 3.930/3.930 casos sem o arquivo de relatório, seguidos de 6/6 do relatório em execução exclusiva, **3.936 casos distintos e zero falhas**. Relatórios `output/campaign-release-unit-20261103.json` e `output/campaign-release-security-20261103.json`, ambos exit0. Backup/dump/restore permaneceram excluídos. O histórico de falhas abaixo é preservado; foi superado nesta reexecução. CI/imagem/implantação do novo SHA continuam como etapas separadas.

Atualização às 16h29: a imagem de `4a6981d` não chegou a ser construída/publicada. O run `41701702769` excedeu 30 segundos nas verificações de layout e canários que repetiam scans/geração completos; o erro de upload do recibo foi secundário à ausência de build. Foi compartilhada a preparação de dois artefatos reais e imutáveis entre reprodutibilidade/layout/canários, sem mocks de scans, supressão de asserções ou aumento dos timeouts dos casos. O hook usa o orçamento de 90 segundos já existente para duas gerações. Ambos os fixtures HIGH/NOT_APPLICABLE passam pelo normalizador e pelos arquivos; verificação de canários e PDF preservadas. Limpeza limitada a diretórios temporários próprios, com raiz/prefixo verificados. Nova suíte focal **6/6**, exit0, em `output/campaign-release-security-shared-20261103.json`. Não se declara CI da nova candidata aprovada antes da execução. O código produtivo de mídia não mudou nesta correção de teste.

Escopo de rollout: somente imagem API/worker e JRC_API_IMAGE por digest, preservando as outras 98 variáveis, frontend, engine, bancos e sessões. Compose main/candidato idênticos, autodeploy desligado e comando customizado vazio. Não há migration nova. Recibo operacional em `output/release-campaign-image-20261103/ESTADO.json` na raiz do workspace.

## Defeito reproduzido

O JRC Conversas criou a mensagem e seu anexo. O Broker recebeu a obrigação e encaminhou a imagem à Evolution. A API da engine retornou um ID; esse aceite não é recibo de entrega do WhatsApp. A mensagem investigada não tinha confirmação de entrega.

A integração usa nomes internos sem extensão, como `anexo-7`, para não confiar no nome remoto. `EvolutionMessagingClient.sendMedia` repassava esse nome ao motor. No upstream pinado, `prepareMediaMessage`:

1. Converte toda imagem com Sharp para JPEG e declara `image/jpeg`.
2. Posteriormente substitui esse MIME por `mimeTypes.lookup(fileName).toString()`.
3. Para nome sem extensão, o resultado é a string `false`; para nome PNG, declara PNG apesar de ter convertido os bytes para JPEG.

A leitura limitada do binário produtivo confirmou essas duas operações. SHA256 observado de `/evolution/dist/main.js`: `71b49ea87b8d0d7b413b77d067e33a8720c2e95e136f632210c1424862ef6b44`. A leitura da mídia sintética já armazenada retornou assinatura JPEG `ffd8ff`, 28.620 bytes e MIME `false`. Nenhuma chave, sessão, telefone ou conteúdo de cliente faz parte deste documento.

Isso comprova um defeito no contrato Broker → Evolution. Atribuir exclusivamente a ele toda ausência de entrega exige o teste operacional posterior; não houve novo disparo para testar a hipótese em produção.

## Correção mínima

No adaptador privado, somente imagens são encaminhadas com `fileName: image.jpg`, compatível com a conversão obrigatória do motor. Os bytes e o MIME de entrada continuam os originais. O motor decodifica a entrada e sua saída passa a manter MIME e bytes JPEG coerentes.

Preservados: legenda, validação de tamanho/tipo, chamada única, resultado ACCEPTED, ID do provedor, outbox, isolamento, credenciais, persistência, custódia e retenção. Documentos, áudio, vídeo e stickers mantêm seus caminhos. O original no storage não é renomeado. Não é necessário trocar a engine produtiva para aplicar essa compatibilidade.

## Evidências e limites

- RED: cinco testes, dois aprovados e três falhando pelo MIME incorreto; inclui execução do método real extraído do upstream com hash verificado.
- GREEN focal ampliado: 16 testes aprovados, zero falhas; inclui texto, mídia Meta, legenda, imagem, formatos não imagem e ausência de retry quando o resultado é incerto.
- Codec real: imagem de laboratório `sha256:adb1941b7015ed3604aa6e716012c26e8fe138c24f7ca67aee321772c34e711c`, Sharp e preparação Baileys reais, rede desabilitada, upload substituído por porta sintética. Antes: MIME `false`; depois: `image/jpeg`; ambos com 28.620 bytes e legenda preservada. Processo terminou com exit 0.
- Typecheck/build TypeScript: exit 0. Revisão independente não encontrou bloqueadores; sugestões adicionais de testes foram incorporadas.
- Regressão ampla: 504 arquivos, 503 aprovados e um com falha; 3.936 testes, 3.935 aprovados, uma falha e nenhum pendente; exit 1, aproximadamente 1.343 segundos. A falha foi `tests/security-audit-artifacts.test.mjs`, caso “não apresenta findings não aplicáveis como pontos fracos”, com duração de 30.017 ms diante do limite de 30.000 ms. O reporter serializou `STACK_TRACE_ERROR`, sem uma diferença de asserção. A coincidência com o timeout é uma pista; não comprova sua causa. O resultado isolado é registrado separadamente. A regressão ampla não é declarada verde nem substituída por CI anterior.
- Escopo da regressão: `npm test -- --exclude tests/backup.test.mjs --exclude tests/recovery.test.mjs --maxWorkers=2 --reporter=json --outputFile=output/campaign-image-full-unit-20261103.json`. As duas rotinas fora de escopo foram excluídas expressamente; não foi executado `ci:verify`.
- Não há script de lint no package.json. `git diff --check` passou. A prova Docker foi apenas de codec/preparação; não substitui PostgreSQL/Redis/MinIO, Rails/Sidekiq, sessão WhatsApp real ou benchmark neste novo candidato.

### Investigação da falha do teste de relatório

O arquivo original repetiu a falha isolado: cinco testes aprovados e um com falha; o caso durou 38.671 ms com limite de 30.000 ms. A mesma geração e asserção, executadas diretamente sem o deadline do Vitest, passaram em 26.797 ms. Isso demonstra que a condição funcional pode passar e que o custo se aproxima do limite; não prova a causa de toda variação de tempo da máquina.

Foi alterado somente o teste: o filtro NOT_APPLICABLE é exercitado diretamente pelo renderer real, com controle positivo OPEN e confirmação de que o item não aplicável continua no inventário. A normalização/escrita desse mesmo fixture foi transferida para a geração de reprodutibilidade já existente. Os testes de pipeline, canários, PDF e seus timeouts foram preservados. Não foi alterado o gerador nem anunciado ganho de desempenho no pipeline produtivo.

A primeira validação dos quatro arquivos afetados após isolamento passou **22/22** (o caso do filtro passou em 1,66 ms). Em revisão, o fixture foi acrescentado a uma geração de canários de 30 segundos para preservar cobertura completa; essa tentativa excedeu o prazo (38.564 ms). A alteração intermediária foi removida, e o fixture foi colocado no teste existente de duas gerações, cujo orçamento original é 90 segundos. O resultado desse último delta é registrado separadamente; não se somam execuções sobrepostas e não se apaga a falha da regressão ampla.

Validação final desse delta: **2/2 selecionados aprovados**, quatro casos não selecionados, zero falhas, exit 0. As duas gerações reais com o fixture passaram em 44.687 ms; o filtro passou em 1,99 ms. O teste de canários voltou ao conteúdo já aprovado na execução 22/22. A suíte ampla não foi repetida após a reorganização exclusiva do teste. CI do candidato continua pendente.

Relatórios brutos: `output/campaign-image-full-unit-20261103.json`, `campaign-image-security-isolated-20261103.json`, `campaign-security-assertion-probe-20261103.json`, `campaign-image-final-focused-20261103.json`, `campaign-image-security-pipeline-20261103.json` e `campaign-image-security-final-20261103.json`. A última validação não substitui uma CI no novo candidato.

As evidências brutas locais ficam em `output/campaign-image-*-20261103.*` no checkout e `output/campaign-media-fix-20261103/` na raiz do workspace. Os registros operacionais identificáveis permanecem fora do Git.

## Canal oficial Meta

Esta correção trata imagem com legenda no canal QR/Evolution. Não transforma uma conexão QR em canal oficial ou em template aprovado pela Meta. A Cloud API possui envio próprio de template com mídia. No código atual do Broker, `dispatcher.ts` rejeita componentes HEADER não TEXT (`META_TEMPLATE_UNSUPPORTED_COMPONENTS`); a extensão completa de template com cabeçalho de imagem é uma lacuna separada, não implementada por este patch e não deve ser anunciada como pronta. O envio nativo Meta do LAB2 tem implementação independente.

## Aceite e publicação

Antes da publicação: revisão do diff final, regressão concluída, CI e imagem no SHA candidato. Depois de implantação autorizada: um único teste de imagem com legenda para destinatário autorizado, correlacionando mensagem local, ID Broker, ID Evolution e recibo entregue/lido ou confirmação do destinatário. Não reenviar automaticamente a tentativa anterior e não alterar seu estado para simular entrega.

Não há migration. Rollback de código: retornar ao digest anterior do Broker, preservando registros e sessões; isso reintroduz o defeito de MIME para imagens. Backup/dump/restore permanecem fora deste incremento.

## Pesquisa e melhorias independentes

[PESQUISA-EVOLUTION-BAILEYS-20261103.md](PESQUISA-EVOLUTION-BAILEYS-20261103.md) reúne as fontes primárias, o fluxo entre os sistemas, as APIs efetivamente implementadas e a matriz priorizada de journal, status, logs, custódia, sessão, grupos, reconciliação e observabilidade. Essas pendências não foram consideradas resolvidas pelo ajuste de MIME.
