# Candidato NICO/Broker de 15/10/2026

## Escopo e publicação

Branch de homologação autorizada: codex/nico-broker-coordenado-20261015.

Bases: Broker 0620ecd0c03ec22252f8518d3a76b6414f6d6cf0 e JRC b58e093dd3a32fe97829a4566660b83ee48b9eca. A instrução de branch separada substitui a entrega direta na main para este candidato. Nenhuma alteração no servidor foi aplicada por este desenvolvimento.

## Incremento inicial Broker

A consulta do histórico também lê o estado atual da conversa e atualiza o rótulo bot/humano. Escopo de conversa/caixa e guards de tenant/aborto são verificados antes de apresentar os dados. O rascunho é preservado.

Uma revisão de mutação local impede que uma resposta GET iniciada antes ou durante uma tomada humana desfaça o modo confirmado. Atualizar histórico não faz PATCH nem envia mensagem. A tela de saúde passa a usar /operations/health, preservando /health para a API e permitindo acesso direto/reload pelo proxy.

Evidência TDD:
- Duas regressões iniciais falharam no código original, por modo obsoleto e ausência da consulta do estado.
- Uma regressão adicional falhou ao aplicar BOT antigo depois da tomada humana confirmada.
- A revisão independente encontrou também GET iniciado durante o PATCH; a regressão falhou no candidato inicial e passou após invalidar a leitura na confirmação da mutação.
- Após a revisão, Messaging.test.tsx: 35 testes aprovados; App.test.tsx: 6 testes aprovados, incluindo o acesso direto à saúde.
- npm run typecheck: aprovado.
- npm test -- --maxWorkers=2 --reporter=dot: 375 arquivos, 2.886 testes aprovados no incremento revisado.
- As restrições iniciais de esbuild/Git/Docker foram resolvidas por execução autorizada dos comandos locais; não foram removidos gates.

## Incremento inicial JRC/NICO publicado na branch candidata

Foram escritos sete cenários sobre janela recente, mensagens privadas, conversa/Account e claim da entrada mais recente. No fonte original: sete exemplos, seis falhas correspondentes ao defeito e uma aprovação de isolamento.

Seis consultas foram alteradas em OperatorSession, ToolExecutor, CustomerTurnJob e ContextBuilder, substituindo order acumulado por reorder. O restante da autorização, formato e limites foi preservado.

Regressões e fluxos existentes de comandos/delegação: 80 exemplos aprovados em sete arquivos no laboratório Rails/PostgreSQL/Redis descartável. O arquivo novo passou novamente com sete exemplos após ajustes de fixture/estilo e RuboCop sem ocorrências. Não há alteração de provedor, modelo, orçamento ou runtime NICO nesta correção.

Fonte JRC: f8938d05846f556a81d6f2917347460eed288099. [CI NICO aprovado](https://github.com/ClaudioHideki/jrc-conversas-lab2/actions/runs/38764982127). [Build e publicação da imagem app aprovados](https://github.com/ClaudioHideki/jrc-conversas-lab2/actions/runs/38766434387). Digest conferido diretamente no registro: `ghcr.io/claudiohideki/jrc-conversas-lab2@sha256:8ea570721344a842dc68875c6f1734268350e5076e9706379f065bd57deaab20`. Esse incremento contém a correção do histórico; o protocolo de tomada coordenada ainda está em desenvolvimento e não faz parte dessa imagem.

O primeiro commit Broker 978f499a2beab045e2eeb417f512cef1bffac0e1 passou no [CI completo](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/38763465516). A revisão de corrida e rota de saúde está publicada no commit 4c7a5eff1a3fa427aa52ef57636b9e00c7ad7fd8 e passou no [CI completo próprio](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/38767447518).

## Continuidade e instalação

O [roteiro do candidato no Dokploy](2026-10-15-candidato-instalacao-dokploy.md) descreve ambiente separado, migrations, configurações por Account, habilitação do NICO e matriz funcional. É procedimento de instalação; não é registro de deploy executado.

O lote seguinte reúne timeout de captura0061, tomada NICO0062 e proteção do lease de vínculo nativo. Depois de acrescentar as cinco rotas NICO ao OpenAPI/inventário, os12 testes HTTP/contrato passaram. A suíte geral executou2931 casos:2930 passaram e o teste de fixture Git da auditoria excedeu15s durante contenção local; o arquivo inteiro foi reexecutado isoladamente, com6 casos aprovados e a fixture em5,4s. Nenhum timeout do produto foi ampliado. Typecheck aprovado.

O ensaio PostgreSQL conjunto apresentou timeouts de setup e expiração de leases durante contenção local; não é registrado como aprovado. Na suíte de vínculo nativo,55 de57 casos passaram em uma execução isolada, incluindo os8 novos. Duas fixtures foram corrigidas para testar o intervalo pretendido; os casos de bloqueio de perfil e timeout de vínculo passaram em seleção focal. O caso legado UNKNOWN passou isoladamente em9,74s depois de exceder o lease legítimo em uma execução mais lenta. Nenhum prazo do produto foi aumentado. O gate consolidado será o CI Linux do commit candidato; essas evidências locais não substituem o CI nem a homologação física.

Lote publicado na branch candidata: `3b15ef6648e708e97d5c59a1b7aa625f491559fc`. No [CI38788489196](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/38788489196), build, migrations a partir de banco vazio, typecheck, testes compilados e os2931 testes gerais passaram. A etapa web focal terminou559/560: o teste de acesso direto à saúde verificava a chamada antes do efeito assíncrono. A correção aguarda a chamada com `waitFor`; o CI deste corte não foi aprovado, e nenhuma imagem desse lote foi declarada publicada.

A tomada coordenada NICO/Broker, os executores de ações/mídia, timeout do Flow, distribuição QR/Flow e demais critérios P0–P10 continuam no programa. A correção da tela não entrega o protocolo distribuído de tomada, e corrigir histórico não torna todos os módulos NICO homologados.

A publicação das branches e imagens candidatas será registrada com CI e digests efetivos. Nenhuma imagem é considerada publicada por existir um Dockerfile ou um commit. O usuário acompanha o candidato antes de qualquer alteração no Dokploy.

