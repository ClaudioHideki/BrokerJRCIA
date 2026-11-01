# Relatório detalhado — Broker JRC

Data: 01/11/2026. Execução incremental da missão mestre, em desenvolvimento.

## Resultado e limite

A candidata visual b076e05 foi publicada no GHCR após os gates oficiais. O servidor continua na versão anterior. A missão recebida durante a execução acrescentou backup e recuperação como condição de implantação; o painel do Dokploy não possui backup configurado. Não se usou a dispensa histórica para remover esse gate.

Foram construídas três melhorias adicionais: diagnóstico de vínculos ativos, proteção contra polling atrasado e separação das evidências no detalhe da conexão. A implementação destas melhorias não significa conclusão do programa integral, do piloto de 30 dias ou da capacidade de 400/900 sessões.

## Como o trabalho foi executado

1. Conferência de branch, HEAD, trabalho local e referência remota, preservando os arquivos existentes.
2. Publicação da branch candidata, sem merge na main, e execução do workflow oficial com testes, banco, filas, storage e assinatura das imagens.
3. Reconexão ao Dokploy, leitura dos containers e imagens e conferência da ausência de backup. Nenhum Environment foi salvo.
4. Leitura da missão e do relatório histórico. Criação da matriz com dois eixos: implementação e validação.
5. Divisão de trabalho por arquivos: observabilidade, ordenação de conexão e interface; revisão cruzada posterior.
6. Para cada correção, primeiro um teste que demonstra a falha, depois alteração mínima e regressão. Testes de PostgreSQL usaram um servidor local novo e dados sintéticos, sem fallback para banco produtivo.
7. Inspeção visual com perfis OWNER e VIEWER, rotas canônica e legada, desktop e celular. O ambiente visual é simulado e identificado; não representa mensagens reais.
8. Consolidação de testes, revisão de segurança/compatibilidade e registros de pendências. O relatório será atualizado com o commit e os gates finais.

## H01 — saúde de vínculos Chatwoot

Problema: o diagnóstico contava estados de conexões desativadas como degradação de conexões ativas. Destinos aprovados também podiam aparentar saúde sem um vínculo ativo ou observação.

Correção: consultas tenant-scoped passam a distinguir vínculos READY, vínculos desativados e suas pendências. Falta de observação ou de vínculo ativo produz UNKNOWN. O número anterior de destinos aprovados é preservado, com origem/escopo explícitos; não foi rebatizado silenciosamente como número de conexões. Totais históricos FAILED e UNKNOWN continuam visíveis e podem manter o estado geral em atenção. Nenhuma fila é limpa ou reativada.

Prova: regressões unitárias e SQL real com jrc_app/RLS, outro tenant, estados não ativos, ausência de observação e registros antigos. Uma revisão adicional identificou o cadastro desativado nunca observado como falso alerta; a correção exige reteste antes de fechar o incremento.

Limites: o snapshot lê estado persistido. Não é sondagem ao Chatwoot remoto e não demonstra atualidade da última observação ou entrega ao WhatsApp.

## B07 — polling e fatos de conexão

Problema: uma consulta ao provider em voo podia retornar depois de um webhook e sobrescrever um fato novo. Comparar apenas status e updatedAt convertido para milissegundos não cobria a corrida.

Correção: o snapshot interno inclui watermark e fingerprint do vínculo; o polling só aplica seu resultado se esse domínio de evidência continuar igual. As colunas já existiam, portanto não foi criada migration ou nova API.

Prova: testes unitários reproduziram a sobrescrita e testes PostgreSQL executaram a corrida pelo serviço/repositório real, incluindo colisão no mesmo milissegundo, controle de mutação que desliga o fence e isolamento entre tenants.

Limites: isso não cria geração de sessão ausente no provider nem resolve toda ordenação global. Entrada HTTP autenticada e falhas de engine permanecem etapas distintas.

## Interface — detalhe das conexões

A visão geral agora apresenta sessão registrada, identidade observada, vínculo de atendimento e entrega em seções distintas. Usa os contratos e links existentes. Perfil do provider não é apresentado como identidade aprovada e o estado conectado não é apresentado como recibo de entrega.

Há testes de estados e navegação. A verificação de navegador cobriu oito combinações de rota/perfil/viewport; sem overflow, erros de página ou violações axe na área nova. Faltam auditoria completa de leitor de tela/contraste e jornada com serviços reais. Não há captura anterior para afirmar comparação visual antes/depois.

## Laboratório e recuperação

Foi iniciado um PostgreSQL 16.4 descartável, limitado a localhost:15439, 1 CPU e 768 MiB, sem dados de clientes. Foram aplicadas as 77 migrations no laboratório. Dump e restauração em outro banco recuperaram 161 tabelas, journal e duas linhas sintéticas, com comparação consistente.

O ensaio cobre schema e dados sintéticos mínimos. Não substitui backup cifrado externo nem restore conjunto de mídia, estado de sessão e chaves. A autenticação de teste foi ajustada somente nesse servidor descartável para atender aos helpers jrc_app; a segurança da produção permaneceu intacta.

## Publicação e testes

A imagem b076 tem evidência própria em evidencias/release-b076.json. Seu workflow aprovou 34 execuções parceiro QR, 3.613 unit/HTTP/frontend, 6 PDF, 1.526 SQL/Redis e 5 MinIO. A soma de etapas não é número garantido de casos únicos. Mudanças posteriores não estão cobertas por esse resultado.

Consolidação local inicial das melhorias: 79 testes focados e 10 testes SQL aprovados, typecheck, build e scanner de bundle aprovados. Os testes dos agentes se sobrepõem a essa seleção. A suíte geral local iniciada foi interrompida sem resultado, portanto não é uma aprovação integral. O reteste final após revisão será registrado em 05-HOMOLOGACAO.md.

## Pendências que impedem declarar conclusão integral

- AUD-B02: captura e obrigação duráveis na origem Evolution, antes do HTTP, com falhas de processo e reprodução da imagem derivada.
- AUD-B03: custódia física, restore completo, retenção e órfãos; KEEP permanece.
- AUD-B05/B12/B13/B14: engine/coletores, replay operacional seguro, orçamento efetivo e justiça entre tenants.
- Grupos, políticas de atendimento e UNKNOWN: investigar pré-condição e destino antes de reprocessar.
- Conector LAB2 e kit externo: homologar versões, grants, revogação e responsabilidades; CCLX tem fork independente.
- Shells completos administrativo/empresa, portal e demais módulos ainda têm jornadas a construir e validar.
- Harness integrado de falhas, recuperação e benchmark progressivo continuam necessários.
- Piloto de 50 números por 30 dias exige operação real autorizada e passagem de tempo; não pode ser antecipado por testes sintéticos.

O arquivo 01-MATRIZ-REQUISITOS.csv detalha aceite, responsável e dependência. O arquivo CONTINUE-AQUI.md registra o próximo passo exato. Nenhum deploy, envio, chamada, replay, migração produtiva ou alteração de dados de clientes foi executado.

## Fechamento deste incremento

A revisão P2 foi corrigida e o reteste consolidado final passou em14casosPostgreSQL(2arquivos),24,10s; typecheckfinalexit0. O buildfrontend e o scanner32bundles passaram. O reteste unitário H01 passou10/10; a seleção consolidadaanterior79/79 permanece evidência sobreposta, não contagem adicional. B07 possui controlede mutação e RLS em banco real.

Nova evidênciaB02: digestEvolution publica proveniênciaOCI/in-toto para cd800f2; comparação de runtime comfa09sem diferenças nos arquivosselecionados. Foram comprovadas janelasvoláteis no código-fonte e proposto journalantesdaPromise, mas não foi implementada captura durável. B02continua pendente.

Relatórios completos H01,B07,UX e B02 e capturas estão em evidencias/. O commitnovo e o resultadoCI devem ser lidos no checkpoint/manifesto do pacote. Alterações desteincremento permanecem candidatas, sem implantação.

## Implementações adicionais de confiabilidade

O journal de origem deixou de ser apenas proposta: há código isolado de captura de texto cifrado, transação, dedupe, leases, recuperação, tentativas e dispatcher com prazo total e recibo explícito. Foram aprovados25 testes. A preparação do hook verifica o hash do código fixado e é exercitada em teste antes da Promise volátil. Contudo, não há bootstrap instalado, supressão comprovada da entrega direta, ACK real do Broker, imagem derivada ou crash de processo homologado. AUD-B02 permanece aberto.

O receptor CCLX ganhou uma implementação PostgreSQL, com persistência atômica antes do ACK, idempotência, conflito de conteúdo, HMAC e mídia em arquivo privado conferido por hash. O fechamento drena operações admitidas e recusa novas. São12 testes do receptor/benchmark aprovados. O filesystem não substitui S3 e o contrato sintético não é uma API produtiva.

Executou-se também um benchmark limitado a750 eventos sintéticos:825 requisições,75 duplicatas,zero erros e750efeitos lógicos persistidos. Os lotes50/100/200/400 não são sessões. Não há GO de capacidade derivado dessa medição.

O CI integral049a410 passou:3.623 testes gerais,1.540 SQL/Redis,5 MinIO e37 jornadas de navegador aprovadas;5jornadas foram ignoradas por perfil. A etapafrontend749se sobrepõe à geral. EstaCI não cobre as adições posteriores de laboratório; será necessária a revisão seguinte.

Os testes automáticos dos novos componentes foram adicionados aos workflows oficiais, impedindo publicação futura sem esses gates. Publicação/implantação/ativação continuam operações distintas. O servidor permanece sem alterações.
