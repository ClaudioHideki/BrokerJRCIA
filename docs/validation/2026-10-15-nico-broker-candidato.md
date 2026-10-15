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

Lote publicado na branch candidata: `3b15ef6648e708e97d5c59a1b7aa625f491559fc`. No [CI38788489196](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/38788489196), build, migrations a partir de banco vazio, typecheck, testes compilados e os 2.931 testes gerais passaram. A etapa web focal terminou 559/560: o teste de acesso direto à saúde verificava a chamada antes do efeito assíncrono.

A correção `4a7decdd4e57dc2c25e37b6089fa6f2fcfe571f6` aguarda a chamada com `waitFor`. Seu [CI completo38790906620](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/38790906620) concluiu com sucesso, incluindo PostgreSQL/Redis, MinIO, jornadas de navegador, OpenAPI, container, restauração e segurança. Isso comprova o lote 0061/0062 e lease de vínculo daquele commit; os incrementos P3 posteriores têm evidências próprias e ainda não estão nessa fonte nem em uma imagem final publicada.

## Editor compartilhado e nativo do P3

O editor agora recebe um cliente autorizado e o escopo da empresa, sem exigir o login da console Broker dentro do JRC. A configuração de etiqueta, atributo, nota, resolução e mídia escolhe as caixas e recursos pelo nome. As respostas de catálogo e upload ficam presas à organização, fluxo, caixa e revisão selecionados. Resolver encerra o ciclo, inclusive dentro de subfluxo; resultado incerto permanece aguardando reconciliação, sem caminho de continuação.

Evidência focal local: 71 testes do canvas/editor compartilhado e controles de espera aprovados; mais 12 testes do transporte, vínculo e montagem nativos aprovados. O TypeScript web passou. O bundle compilado foi exercitado em navegador local com uma central sintética: abrir o editor, escolher a caixa, editar nota privada, respeitar ausência de permissão de publicação, isolar CSS e encerrar sessão passaram. O ensaio não enviou mensagens e não acessou o JRC do servidor.

Fontes nativas e scripts de build são rastreados no Git, sem dependência de `.sessions` como fonte. O build registra o commit Broker, hashes de entradas e saídas e licenças; uma instalação de release rejeita fonte não commitada. Os assets finais do JRC serão gerados do commit Broker fechado e terão versão para evitar cache do editor anterior. Esta evidência local não publica nem instala uma imagem.

A revisão do editor acrescentou seleção explícita de uma nova revisão de recurso/arquivo e checagem do contrato de revogação de mídia (`revision`). Os nove cenários do editor de ações, oito de transporte de ações e 35 regressões do histórico/modo humano passaram em conjunto (52 casos). O editor compartilhado rejeita um rascunho retornado para outra organização; essa regressão e as jornadas existentes do editor passaram (59 casos no conjunto). Não se ampliaram permissões para contornar erros de configuração.

O detalhe da conversa agora tem uma projeção privada de ações standalone, sem misturar notas com mensagens de transporte: etiquetas por nome, atributos tipados, estado do fluxo e até 100 notas recentes com aviso explícito quando há outras. Contratos/interface/regressões do serviço: 20 casos aprovados. PostgreSQL real com `jrc_app`: quatro casos aprovados, incluindo isolamento por organização/caixa, ausência da projeção em caixas centrais, revisão `int8` exata e nenhum novo registro de mensagem por uma leitura. A consulta é uma única leitura sob a transação tenant existente.

## Corte integrado candidato

O incremento atual acrescenta o protocolo coordenado de envio NICO, timeout persistido de captura, editor compartilhado com escopo delegado e os cinco blocos de etiqueta, atributo, nota privada, mídia e resolução terminal. A imagem NICO runtime não foi alterada: as mudanças do assistente estão no backend e interface do JRC e na coordenação do Broker. A branch e imagem JRC de produção do outro desenvolvedor são preservadas.

| Verificação local deste corte | Evidência |
| --- | --- |
| NICO: autorização no commit, cancelamento e vínculo QR/nativo | 30 exemplos Rails/PostgreSQL aprovados |
| Catálogo, motor puro, simulação e canvas dos cinco blocos | 132 testes aprovados; disponibilidade habilitada |
| Importação e publicação de ações | 63 casos aprovados; v1 continua legível, sem converter autoridade externa |
| Recursos, upload, prova e assinatura de arquivo | 17 testes focais aprovados e quatro casos PostgreSQL de recursos |
| Delegação e armazenamento privado | Três casos de escopo/revogação e um de PUT incerto aprovados; nenhum segundo PUT |
| Central e persistência | Dez casos PostgreSQL aprovados; fato remoto separado da permissão de continuação |
| Recuperação final de mídia e claim | Três casos PostgreSQL aprovados: subfluxo, confirmação antes do mirror e claim sem admissão; nenhum reenvio |
| Metadados de prova | Três casos aprovados; UUID malformado não chega ao cast SQL |
| Revisão do vínculo nativo | Cinco casos de interface aprovados; rollback permite nova preparação e confirmação exige a intenção correspondente |
| Build nativo | Falha de verificação preserva os quatro arquivos já instalados; promoção ocorre depois da validação |
| OpenAPI e inventário | 30 testes afetados aprovados; upload binário documentado nas duas fronteiras |
| Build e segurança | Compilação TypeScript/web aprovada; 329 rotas, nenhum achado dos scanners |

Os números acima são conjuntos focais e podem sobrepor casos; não devem ser somados como uma suíte única. A execução geral obrigatória, os guards do JRC e o CI do commit final têm registro separado. Os assets de release do editor serão gerados do commit Broker fechado e incluídos no candidato JRC. O [registro P3](2026-10-15-p3-effects-broker.md) detalha as migrações e limites.

A rodada geral local executou405arquivos/3.087casos:3.071passaram e16 falharam em expectativas antigas de inventário/paleta/status HTTP e mocks sequenciais de SQL. As correções mantiveram as restrições e, na execução final dos sete arquivos afetados,85casos passaram. A compilação, o inventário atual e a geração do OpenAPI também passaram. Não se registra a primeira rodada geral como aprovada nem se amplia timeout do produto. A suíte PostgreSQL final de protocolo/recursos/lifecycle aprovou49de50casos; o inventário de policies foi atualizado para incluir somente a policy nova `effect_control_tenant` e passou na seleção focal. O CI do commit final é o gate consolidado.

Esses testes não encerram todo o programa P0–P10 nem comprovam uma implantação do servidor. A conversa física com QR, os ativos Meta, o Chatwoot externo ainda indisponível e a capacidade de 500 empresas/10 mil conexões têm critérios próprios de homologação. Configuração do candidato e comandos por Account constam no roteiro Dokploy.

A publicação das branches e imagens candidatas será registrada com CI e digests efetivos. Nenhuma imagem é considerada publicada por existir um Dockerfile ou um commit. O usuário acompanha o candidato antes de qualquer alteração no Dokploy.

O CI do corte `fe8f3d6` aprovou build, editor compilado, migrações vazias, TypeScript, suíte geral e interface; os 13 erros PostgreSQL de `flow-service` revelaram a constraint histórica 0053 limitada a 11 guards. A correção aditiva 0064 exige os 19 guards atuais e invalida apenas provas nativas ainda consumíveis, mantendo os fatos já ativados e o transporte STOCK. Não altera os bytes de 0053. Regressão de upgrade primeiro reproduzida em falha; após a correção, os 60 cenários do serviço e o upgrade passaram em conjunto. Doze testes de baseline/journal e TypeScript também passaram. A revisão independente não encontrou P1/P2 nesse reparo; o CI do novo commit será a evidência consolidada.

