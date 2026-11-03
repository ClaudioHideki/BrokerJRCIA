# Engine JRC: contexto e imagem candidata de laboratório

## Incremento runtime de 02/11/2026 — artefato validado e fonte posterior

**Estado atual:** a imagem f670 abaixo passou nos gates físicos descritos.
Depois desses gates, a fonte candidata mudou para 11 overlays, observador
explícito de laboratório, registro do host compartilhado entre loader/bundle e
remoção do console incondicional de notify. Essas fontes têm regressão local
22/22 GREEN, mas ainda não possuem imagem/gates próprios. Os resultados de
f670 não são transferíveis para o próximo artefato. Captura produtiva permanece
false e ownership permanece UNPROVEN.

Imagem final após correção de SIGINT: contexto engine-IaEIMb,313 insumos e10
overlays; engine-supervisor-signals-image-build.log concluiu exportação e unpack.
Tag local jrc-evolution-engine:lab-supervisor-signals-20261102,
IIDf6704623f7b66c792b21501bac7a8ab20c982a6fabbe1d54f16ff0b8542dcf5e,
manifestd0172182e09870c85506f425fb0d6cac6676334cea41142b93e9f85325b799b8,
config92991e9491bb1e8fc717197e1dc001199df70089cdc69ce7c6cfaef264459fc2.
Prisma16,2s, tsc/tsup56,56s, prune na etapa186,3s e record-build73,9s.
O IID9e93 abaixo é intermediário e não contém essa correção. O teste focal
engine-supervisor-sigint-red.log reproduziu143 em vez de130; depois
engine-supervisor-sigint-green.log passou9/9,30.654,871ms. Não somar essas
rodadas aos61 casos anteriores. Gates de admissão da imagem f670:4/4 GREEN,
engine-supervisor-signals-image-gates.log e image-gates-669dd13e08/report.log,
exit0. Leitura completa34439 entradas/5909389bytes, UID1000/Prisma6.19.0,
scan160662ms e RSS103884KiB sob cgroup192MiB/heap128/1CPU. Capture true,
flag inválida e recibo adulterado recusados com exit1 em2873/2783/2838ms,
sem importar o canário nem expor segredo. Cinco nomes de container confirmados
ausentes/removidos. Sem rede, PG ou main nessa matriz; o boot real é a prova abaixo.

**Gate físico da imagem final: GREEN**, engine-supervisor-signals-provisioned-gate.log,
provisioned-gate-e7f6df499f/report.log, processo de teste exit0. Schema explicitamente
provisionado em6518ms,110 relações, zero instâncias. Cancelamento durante inventário:
exit0/COMPLETE em1124ms. Cancelamento durante import do main: exit143 em2952ms,
ready=false/forced=false, sem COMPLETE. Nessa primeira inicialização o scan completo
levou141278ms. A engine principal depois alcançou HTTP em86118ms (86,118 segundos),
com novo scan de34439 entradas em66788ms. GET autenticado /instance/fetchInstances
retornou200 e array vazio. Shutdown levou1461ms, exit0, ready=true/forced=false,
duas mensagens Repository:Prisma OFF e COMPLETE do filho e do supervisor.
OOMfalse; nenhuma sessão criada, zero chaves Redis, zero DDL observado na vida da
engine. Catálogo antes/depois idêntico:
e70784a027a4638b3b16fa412015e5e9885f77963f475454da7110656047c0d4.
Amostra de memória: engine354,4MiB/512MiB, PG72,03MiB/192MiB e Redis4,559MiB/64MiB.
Tempos de observação incluem chamadas da CLI; não são benchmark de capacidade nem
prova de ganho de desempenho. PID host/filho não foi persistido por esse harness.

Após o shutdown real, a subprova de custódia dos módulos da mesma imagem passou
em8370ms: dois SIGKILL reais de filhos Node/Linux, depois do COMMIT da origem e
depois do COMMIT do receiver antes do ACK; os mesmos eventos foram recuperados,
com2 eventos DELIVERED e2 linhas únicas no receiver, zero efeitos legados no replay
e zero bytes emitidos pelos filhos. Essa subprova declara engineMainImported=false,
origem/receiver sintéticos e PostgreSQL vivo em tmpfs: não prova crash de PG/host,
hook em sessão real ou ownership da captura produtiva. Nenhum segredo sintético
apareceu nos logs. Os7 containers e a rede foram confirmados removidos; o volume
tmpfs foi descartado. Boot HTTP e custódia modular são níveis distintos de prova.

Próxima lacuna reproduzida depois desses gates: o InstanceController upstream
chama ChannelController.init antes de gerar/atribuir instanceId. Sob o host
explícito de captura, o overlay exigia identidade cedo demais. Novo teste
engine-api-construction.test.mjs executa InstanceController, ChannelController
e construtor Baileys inteiros compilados, com DB/settings/network sintéticos:
engine-api-construction-red.log1/1 RED, ORIGIN_ENGINE_INSTANCE_INVALID;
engine-api-construction-green.log1/1 GREEN após mover a atribuição do mesmo UUID
para antes do init, sem mudar pin upstream. InstanceController passa a ser o
11º overlay, SHA256 LF b0921eac4e202344e9c3100754965f1b97db94faf74b7b2089ac7cca16d5713f.
Regressão focal das quatro suítes20/20,3908ms, zero skips/falhas. Essa correção
**ainda não pertence à imagem f670**: exige novo artefato e prova do hook real.
Ela não altera os resultados já medidos com captura false, mas impede considerar
f670 prova de captura instalada via criação real. Nenhum pairing foi feito.

Dois pré-requisitos adicionais foram reproduzidos antes do próximo build.
engine-host-evaluation-red.log mostrou que uma segunda avaliação do módulo não
enxergava o host instalado pelo loader; o registro process-local compartilhado
por Symbol corrige isso sem instalar host automaticamente. O teste completo
de notify revelou console.log(messageRaw) expondo texto mesmo sem verbose:
engine-handler-privacy-red.log RED true!=false, handler inteiro executado.
O overlay remove somente esse console incondicional, sem alterar o hash/pin
original. engine-handler-privacy-green.log:22/22 GREEN,2532ms. Isso não é auditoria
de todos os logs verbose, mídia ou erros upstream. Contexto atual engine-xdNVbe,
11 overlays; engine-FE3cdt e engine-tIfy7V são estágios intermediários preservados.
O runner engine-real-hook-gate.mjs está preparado para usar main/controller/
handler/Prisma/fanout reais com porta de socket sintética, COMMIT da origem seguido
de SIGKILL e restart fechado; ainda não executado. Não confundir preparo com prova.

As observações Linux sintéticas preservam os limites de cada rodada:
supervisor-linux-c8b00a9de4 confirmou TERM143 e INT130 durante import bloqueante,
HTTP admitido concluído e saída0, saída23 e crash137. O caso travado registrou
forced=true e137, FinishedAt em8.920ms, mas o assert antigo usava a conclusão
da CLI em14.408ms e falhou. O harness passou a medir FinishedAt do daemon,
mantendo stop10s, watchdog8s e escalada7s. Uma nova rodada d43cf61551 interrompeu
no limite antigo de5s da CLI do primeiro caso; não é prova7/7. O caso isolado
parent-kill em a0cb0c9c52 passou: SIGKILL ao PID1 encerrou o namespace,
exit137/OOMfalse/PID0; restart do mesmo container teve execução nova e parada143.
Esse teste usou módulos/entrada sintéticos recebidos, não o main da engine.

Semântica explícita: cancelamento durante inventário, antes de existir filho,
pode terminar0 com SHUTDOWN_COMPLETE; não implica READY, boot saudável ou
ownership. Cancelamento do main antes de ready preserva143/130; encerramento
ativo normal é0, e encerramento forçado é137. Nenhum desses sinais homologa
sessões. A prova de boot real provisionado e a prova de módulos de custódia
continuam separadas.

O incremento autorizado pela execução integral corrige o encerramento observado
como exit137 e prepara um gate de schema explicitamente provisionado. A fonte
upstream permanece limpa no pin fa09d378; não houve edição de produção, mudança
de pin, backup/dump/restore, pairing, sessão ou envio real.

Decisão implementada: lifecycle JRC com SIGTERM/SIGINT idempotentes, cancelamento
do inventário por AbortSignal, fechamento da admissão HTTP e espera pelas
respostas admitidas, espera do carregamento inicial e fechamento dos clientes
Prisma/Redis registrados. Não há process.exit(0): sucesso exige saída natural
sem handles pendentes. Erro/pendência excedendo 8s gera diagnóstico fixo e exit1;
o gate mantém Docker stop10s. Uma instância presente em waInstances causa
ORIGIN_ENGINE_SESSION_DRAIN_UNPROVEN: não efetua logout/delete nem simula prova
de shutdown de sessão. O fechamento de sessões e do host produtivo continua
fora desta prova.

Três fontes adicionais recebem overlays com hash LF completo: main.ts,
repository.service.ts e rediscache.client.ts. O staging passa de sete para dez
entradas pinadas e inclui o mesmo lifecycle no runtime e na base de confiança
do guard jrc-image; nenhum módulo aplicativo de jrc-origin é importado antes
do inventário. O guard e o bundle compartilham um registro de processo. A nova
travessia usa no máximo oito operações/streams simultâneos, preservando
ALL_NODE_MODULES_V1, todos os arquivos, hashes e regras de symlinks. A ordenação
final permanece determinística. O guard registra contagem e duração do scan,
sem configuração, URI, payload ou segredo.

Evidência anterior ao gate físico (logs em integrations/evolution-origin-journal/build):

- runtime-lifecycle-red.log: Windows3/3 RED por necessidade de SIGKILL.
  runtime-lifecycle-linux-red.log: Linux3/3 RED, SIGTERM real interrompia a
  resposta HTTP admitida. Windows emite o evento de processo e não prova POSIX.
- runtime-lifecycle-green.log:3/3; runtime-lifecycle-linux-green.log:3/3,
  1.793,422ms. Incluem resposta HTTP real, fechamento, erro sanitizado e hang.
  O teste revelou keep-alive tornando-se ocioso após close(); closeIdleConnections
  roda somente após finish, sem destruir respostas ativas.
- runtime-overlay-red.log:2/2 RED, ausência de registro dos dois clientes Prisma
  e do servidor. runtime-overlay-green.log:2/2 GREEN em fontes pinadas compiladas;
  dependências externas desse teste são sintéticas, não PG/engine reais.
- runtime-inventory-abort-red.log:1/1 RED; runtime-inventory-abort-green.log:2/2
  GREEN, cobrindo cancelamento prévio e interrupção de stream já iniciado.
- runtime-regression-green.log:22/22, zero skips,105.482,426ms; depois
  runtime-origin-regression-green.log:30/30, zero skips,2.574,894ms. O segundo
  caso de cancelamento foi acrescentado depois: não somar rodadas sobrepostas.
  stripTypeScriptTypes mantém o aviso experimental preexistente.
- Regressão final dos oito arquivos na fonte atual: **53/53**, zero falhas/skips,
  exit0,88.410,954ms; runtime-regression-final.log. Inclui staging, recibo e
  canários de dependências completos, sinais, overlays, host, proveniência e
  composição compilada. Não substitui npm test integral, CI ou os gates físicos.

Contexto engine-iMT1Vy com311 insumos e10 entradas pinadas, ownershipUNPROVEN,
captureDefault=false. Build local engine-runtime-image-build.log passou
tsc/tsup, Prisma Client6.19.0 e recibo completo (etapa record-build94,6s,
incluindo validação de insumos). Tag jrc-evolution-engine:lab-runtime-20261102,
IID25479f1a7e70ac36468e0c9632b0056d4ac7f679d20aae4c085bf9d4689a01c1,
manifest e23bd8461427bff7f417d2c574ae1047a18c873586e0edb97dff8162ab784828,
config3d23584fa858c4a6c0cae00092af40fb27c71527b364f88035baa67c4b5bd090.
Avisos SWC/import.meta do instalador CJS permanecem. Não foi publicado registry.

O novo tests/engine-provisioned-gate.mjs prepara exclusivamente PostgreSQL novo
em tmpfs/rede interna, usa PrismaCLI da própria imagem para db push explícito
antes do boot e exige leitura autenticada de zero instâncias, catálogo
provisionado inalterado e parada da engine real com exit0. Não usa auto-migração
do entrypoint ou --accept-data-loss. Também observa parada durante o scan e
durante o import inicial, sem transformar falha de startup em readiness.
Após parar a engine, tests/engine-artifact-custody.mjs instala explicitamente o
journal nesse laboratório e exercita os módulos JRC da mesma imagem com PG/HTTP
reais, origem/receiver sintéticos e SIGKILL após COMMIT da origem e do receiver
antes do ACK. Essa subprova não importa dist/main e não habilita captura no
entrypoint: o protocolo declara esses limites e mantém ownershipUNPROVEN.

Primeiro gate provisionado da imagem25479f: **RED**, sem ocultar a falha.
provisioned-gate-3a3d9631fe/ registra provisionamento explícito9.086ms,
110relações e zero instâncias. SIGTERM durante scan saiu0 em1.069ms; durante
import após scan130.112ms ainda exigiu SIGKILL Docker, exit137 em12.346ms,
OOMfalse. A importação síncrona bloqueia o loop JS antes de bootstrap instalar
os handlers. O boot completo e a custódia não foram alcançados nessa rodada.
Cinco containers e a rede foram removidos e a base tmpfs descartada.

Correção subsequente: o entrypoint conserva o inventário integral e passa a
supervisionar um filho que importa main. Esse filho repete a recusa de captura,
ownership e valida o recibo e hash do main antes do import; IPC transporta
somente hashes de admissão e readiness. O pai preserva saída23/sinal137, e
cancelamento pré-ready é143, sem SHUTDOWN_COMPLETE. Encerramento envia SIGTERM
ao grupo do filho; após7s sem saída, força SIGKILL e registra falha137 antes
do limite8s do pai. Windows usa IPC cooperativo depois de ready, pois seu
child.kill(SIGTERM) encerra abruptamente e não prova semântica POSIX.

engine-supervisor-red.log:5/5 RED no desenho anterior. Após implementação,
engine-supervisor-bounded-green.log:13/13 incluindo admission/lifecycle/overlay,
zero skips,31.025,892ms. Teste de import bloqueante, resposta HTTP admitida,
saída/crash e filho travado foram executados no host Windows; prova Linux
permanece separada. O teste físico engine-supervisor-linux-gate.mjs usa main
sintético recebido e não a engine real. A garantia de terminar descendentes
após SIGKILL do pai exige o supervisor como PID1 em namespace isolado:
[a semântica do kernel está documentada em pid_namespaces(7)](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html).
O handler IPC de disconnect é adicional; não garante resposta enquanto import
síncrono bloqueia fora desse namespace. Parent-kill standalone/Windows não é
homologado. npm test integral e Git/CI seguem coordenados pela raiz.

Build com supervisor: contexto engine-IiAzqk,313insumos/10overlays;
engine-supervisor-image-build.log exit0. tsc/tsup concluídos em61,96s,
npm prune encerrado na etapa279,7s e record-build71,8s. Tag local
jrc-evolution-engine:lab-supervisor-20261102,
IID9e93d4d51d4e737cba8b55a80e3a42a44bf5835e5ed887f8abde82354a2fbe1f,
manifest90061366685dea664c712bc2cd7b4585bb853f2c7ffdd971347a2cf20f0ab837,
config0754fb0c80b878d36cd50852b88ff98fc69cd9c06b7abe8924ac745d8345659a.
Regressão dos nove arquivos: **61/61**, zero falhas/skips,170.071,170ms,
engine-supervisor-regression.log. Gates físicos desta imagem ainda pendentes.
Primeira matriz Linux sintética (supervisor-linux-252386816b) confirmou
exit143/OOMfalse no import bloqueante, mas falhou no assert de tempo da CLI
menor5s durante concorrência com build. A duração não foi salva antes do
assert; o harness foi corrigido para registrar duração e FinishedAt antes
de avaliar o limite. Essa rodada não prova performance nem os demais casos.

Gates da imagem25479f sem PG/main: **4/4 GREEN**, recibo34.437 entradas e
5.909.113bytes, UID1000, client6.19.0, scan166.271ms e RSS104.192KiB com
heap128/cgroup192/1CPU. Capture true/flag inválida/recibo adulterado falharam
antes do main em1.229/1.579/1.674ms. Logs engine-runtime-image-gates.log e
image-gates-5f9c17489d; os cinco nomes de container foram confirmados ausentes.
Não houve extensão de budget240s para leitura ou20s para recusas.

Esse scan foi mais lento que86.661ms da observação histórica478f. Um experimento
LIFO, lendo o mesmo recibo completo fora do código instalado da imagem, levou
88.948ms/RSS107.356KiB; microteste sem I/O mediu FIFO34.437itens484ms e LIFO0,5ms.
O deslocamento de fila sozinho não explica a diferença de80s; cache/carga/I/O
não foram controlados. **Não há ganho de performance comprovado.** A execução
coordenada decidiu manter o código correspondente ao artefato25479f e preservar
o experimento apenas em build/runtime-inventory-lifo-experiment.mjs.log e
runtime-inventory-lifo-benchmark.log (ignorados pelo Git). Hash SHA256 do scanner
atual e do contexto construído:68097f2b3e1c3d7422575c6691ad4d78c2c4baf89a5b65a88ac120198380c514.

**Estado após revisão independente P2, 02/11/2026:** código corrigido para
inventariar TODO node_modules, regressão Node Windows **46/46**, teste Linux de
links **1/1** e nova imagem candidata local com gates físicos **4/4**, zero skips.
Nova tag `jrc-evolution-engine:lab-20261102-p2-ea7dc741`, IID
`sha256:478f06ec545cfbed64bdfcb9a7593e1c35733433487fbe0f6b493e3e2943ca7e`.
O leitor completo levou 86,661s para 34.435 entradas; esse custo é risco de
startup da candidata, não autorização para produção.
A imagem local `jrc-evolution-engine:lab-20261102-ea7dc741`, IID
`sha256:d4aacdba62c1fc9e5d3892bb5736cdf2b58f9a1787d04434da1309805683f848`,
é **anterior à correção e tem recibo parcial**. Os 37/37 e 4/4 da primeira fase
abaixo são históricos desse artefato, não validam a correção P2. Rebuild, matriz
POSIX e novos gates físicos foram executados depois da liberação expressa do
slot pela raiz, com o stack TLS encerrado. Captura false e ownership
UNPROVEN permanecem. Gate posterior exercitou boot real com PG prístino e
registrou schema ausente, sem homologação operacional, sessão ou alteração
produtiva. CI/publicação continuam não executados para esta candidata.

## P2 independente: dependências fora do Prisma

A revisão Ack encontrou inventário de apenas .prisma/@prisma, embora o Dockerfile
copie todo node_modules. Uma dependência importada pelo main podia mudar sem
detecção prévia. A correção alterou somente arquivos da família engine já
autorizada:

- artifacts.mjs percorre toda a árvore node_modules, inclusive pacotes aninhados,
  arquivos não-JS e shims Windows; hashes usam streaming para limitar memória.
- Links só são aceitos em folhas `.bin` imediatamente sob node_modules, inclusive
  árvores aninhadas: alvo relativo, confinamento lexical e por realpath à árvore
  global node_modules, alvo final arquivo regular. Outros links/junctions,
  destinos absolutos, escape e alvo diretório são recusados. O recibo armazena
  tipo, alvo normalizado, alvo real relativo e hash; bytes iguais não ocultam
  retarget de binário.
- record-build.mjs exige o inventário completo e grava
  `dependencyInventory=ALL_NODE_MODULES_V1`. entrypoint exige esse marcador e
  compara o conjunto/hashes completo em uma passagem antes do import do main;
  recibo de escopo antigo não é aceito.
- O harness de imagem exige o marcador novo e recebe só protocolo pequeno em
  stdout. O recibo é copiado por docker cp de container criado/nunca iniciado;
  tamanho/contagem são registrados como metadados ainda não validados antes do
  scan. Receipts canários são gerados com mutação in-place, sem clones múltiplos.
  O primeiro leitor de 20s atingiu timeout; o recibo completo tem 5.908.822 bytes.
  Só o leitor passou a ter orçamento explícito de 240s, baseado no scan de build
  de 142,8s; as recusas mantêm 20s. Não foi cortado inventário ou assert.

TDD em processo Node real, com pacote sintético efetivamente importado pelo main
(não Prisma real, engine real ou sessão):

- RED inicial: quatro subcasos de modificação/adição/remoção/junction falharam.
  Na remoção, MAIN_ENTERED apareceu antes da falha; nos outros três houve exit0
  indevido. 5 falhas incluindo o pai, 19.023,5751ms; engine-dependencies-red.log.
- RED ampliado: 7 subcasos + pai falharam (8/8), 11.598,9082ms. Inclui ausência
  de pacote/shim no recibo, shim alterado e escape por junction em .bin.
  engine-dependencies-bins-red.log.
- GREEN focal: 8/8, zero falhas/skips, 16.990,0343ms;
  engine-dependencies-green.log.
- Política da plataforma Windows:1/1, 481,1775ms; shims regulares e recusa de
  junction, em engine-bins-windows-green.log. Symlink de arquivo retorna EPERM
  neste host, inclusive fora do sandbox. Não foram alterados privilégios nem
  adicionados skips; o ramo POSIX foi executado depois no slot autorizado abaixo.
- Regressão serial final de seis files, heap128MiB: **46/46, zero falhas/skips**,
  exit0, 86.472,3844ms; engine-dependencies-regression.log. Aviso experimental
  stripTypeScriptTypes já existente. Não somar execuções sobrepostas.

Todos esses logs usam o prefixo integrations/evolution-origin-journal/build/.
Ack fez revisão estática da correção e não identificou P1/P2 residual no código.
Não executou runners; os outputs físicos posteriores seguem para nova revisão.

Teste leve POSIX preparado no mesmo engine-build.test.mjs: selecionar
`--test-name-pattern='runtime bins'`. O teste não executa Git nem staging de
fontes; usa somente diretório sintético próprio e runtimeInventory. Em POSIX
verifica link relativo válido, alvo/hash registrado, retarget com bytes iguais,
link absoluto, escape, diretório, dangling e .bin aninhado. Em Windows verifica
os shims nativos e junctions. Não declarar o ramo POSIX coberto pelo GREEN Windows.

Os outputs físicos P2 receberam revisão independente sem P1/P2 novo. O gate
posterior de boot real/PG prístino e seus limites estão documentados abaixo.
A imagem d4 anterior permanece apenas evidência histórica
e não deve ser publicada como contendo este P2. Nenhum runtime host, workflow,
package/lockfile upstream, produção ou política de backup foi alterado.

## Rebuild P2 e gates físicos, após liberação do slot

- Linux: seleção `runtime bins`, **1/1**, zero skips, caso 387,80914ms e total
  943,373181ms; `build/engine-bins-linux-green.log`. A imagem d4 serviu somente
  como interpretador Node24 da fonte atual montada readonly; entrypoint
  substituído por Node test, netnone, cap-drop ALL, nonroot, heap128/cgroup192MiB,
  staging sintético próprio em tmpfs. Nenhum main real ou cliente PG executado.
- Contexto novo `engine-QGt13s`, 309 insumos, pin fa09 e ownership UNPROVEN;
  `build/engine-build-context-p2.log`. Build exit0, 398.028ms, heap Node1536MiB;
  Prisma generate com `RUN --network=none`, sem conexão/DDL. Scan do recibo no
  build: 142,8s; `build/engine-image-p2-build.log` e `*-build-metrics.log`.
- Imagem corrigida local IID/index `478f06ec545cfbed64bdfcb9a7593e1c35733433487fbe0f6b493e3e2943ca7e`,
  manifest `5f24ac8c738cfaa38d1aa009006d590dadb186671743c41424c35ada5f8dc6ea`,
  config `23e925f22c51ebeaeba6e3682dc44a7cb6b7207a3ecf6f49e356e3adad4b8bf7`.
- Primeira tentativa de reader: **RED ETIMEDOUT 20s**. Cleanup do container do
  contrato ficou inicialmente UNPROVEN durante corrida de remoção automática;
  consulta posterior confirmou ausência. Evidência preservada em
  `build/image-gates-7b05ba8cb0/{contract-result,cleanup,cleanup-followup}.log`.
  O harness agora repete apenas inspect do nome próprio por até 5 tentativas;
  falha de daemon nunca vira ausência e gera cleanup_unproven + falha do gate,
  sem ampliar remoção ou tocar outros serviços.
- Rodada corrigida: **4/4**, exit0, em `build/engine-image-p2-gates.log` e
  `build/image-gates-2d1e8f2104/`. Contrato real com 34.435 entradas,
  5.908.822 bytes, scope ALL_NODE_MODULES_V1, UID1000, Node24.19.0,
  Prisma Client6.19.0 e header ELF verificado. Scan 86.661ms, caso total90.985ms,
  pico RSS108.408KiB, heap128MiB/cgroup192MiB/1CPU, reader budget240s.
  Capture true1.630ms, invalid flag1.047ms, tampered ownership1.205ms;
  todos exit1 sem import do main/canário ou divulgação do canário. Os três
  permanecem com budget20s. Cleanup dos cinco nomes próprios confirmado em
  `cleanup.log`; nenhum container iniciado para a cópia do recibo.

O custo de leitura integral é material para startup/healthchecks e precisa de
avaliação antes de release operacional. Estes gates não medem o boot completo
do entrypoint false: o contrato usa reader explícito e as recusas usam canário
inofensivo com hash correspondente. Estes quatro casos não usam PG; não
comprovam sessão, ownership durável, equivalência produtiva, CI/registry ou
publicação. O gate posterior de PG prístino é separado.
Os avisos CJS import.meta no instalador e SWC emitDecoratorMetadata continuam
registrados; o instalador do host não foi exercitado nem alterado neste incremento.

## Configuração explícita necessária para o runtime da candidata 478f

A imagem define DOCKER_ENV=true. Nesse modo o constructor upstream
src/config/env.config.ts sobrescreve SERVER.TYPE com SERVER_TYPE sem fallback.
O contrato da configuração usada neste laboratório fornece explicitamente:

| Variável | Papel nesta candidata |
| --- | --- |
| SERVER_TYPE | http no laboratório; omitir causa servidor undefined antes do listen |
| SERVER_PORT | 8080 interno; sem publicação de porta no host |
| SERVER_URL | URL HTTP interna do container dedicado; nenhum domínio real |
| DATABASE_CONNECTION_URI | PostgreSQL novo, usuário/senha sintéticos e schema public vazio |
| CACHE_REDIS_ENABLED / CACHE_REDIS_URI | true e Redis novo dedicado, sem dados persistidos |
| AUTHENTICATION_API_KEY | Canário sintético exclusivo; nunca usar o default upstream |

DATABASE_PROVIDER=postgresql e captura false são defaults da imagem preservados.
No gate, TELEMETRY_ENABLED=false, SENTRY_DSN vazio e integrações desativadas
completam o isolamento. A primeira tentativa real importou o main e conectou ao
Prisma, mas omitiu SERVER_TYPE e terminou com TypeError reading listen; esse é
erro da configuração da fixture, não comprovação de boot saudável ou regressão
que justifique editar upstream/defaults. A imagem 478f não foi modificada para
contornar esse resultado. Nenhum desses campos é autorização para sessão,
provisionamento de schema ou uso produtivo.

## Gate posterior: entrypoint real false com PostgreSQL/Redis prístinos

Script manual `tests/engine-pristine-gate.mjs`, executado somente após liberação
do slot. Usa a imagem 478f por ID imutável com ENTRYPOINT real, captura false
herdada (não sobrescrita na CLI) e recibo completo. Novos nomes/labels nonce,
rede internal sem portas publicadas, PG192MiB/0,5CPU e Redis64MiB/0,25CPU em
tmpfs novos, engine heap256MiB/cgroup512MiB/1CPU e readonly com tmpfs próprios.
Imagens locais imutáveis dos serviços:

- PostgreSQL16-alpine: `sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229`.
- Redis7.4.0-alpine: `sha256:c35af3bbcef51a62c8bae5a9a563c6f1b60d7ebaea4cb5a3ccbcc157580ae098`.

Nenhum dado/configuração/volume preexistente é montado ou alterado. O initdb do
container PostgreSQL novo cria seu banco básico prístino; o script não executa
migrações da engine, bootstrap do journal, installer, seeds ou SQL de gravação.
O SELECT da engine é solicitado por DATABASE_SAVE_DATA_INSTANCE=true para
observar explicitamente ausência da tabela, sem criar instâncias. Telemetria,
Sentry e integrações são desativadas; rede não permite egress externo. Nenhuma
rota de QR, sessão, WhatsApp ou envio é chamada, nem é feita chamada HTTP de
readiness que pudesse mascarar o schema ausente.

Primeira tentativa (`build/pristine-gate-68930d205c/`, log driver
`build/engine-pristine-gate.log`): **FAILED_OR_INCONCLUSIVE**, exit1. Em
104.945ms chegou ao main/Prisma e sofreu TypeError por SERVER_TYPE omitido na
fixture. Catálogo before/after já idêntico, zero relações de usuário/keys Redis,
sem OOM ou divulgação dos canários; isso não virou GREEN. Três containers foram
removidos, mas a classificação inicial do erro Docker network-not-found marcou
cleanup_unproven. A consulta posterior em cleanup-followup.log confirmou rede
ausente. Histórico preservado; nenhuma remoção ampla. O harness reconhece agora
esse formato explícito de ausência e mantém daemon/inspect falho como UNPROVEN.

Segunda tentativa (`build/pristine-gate-52b80a9317/`, driver
`build/engine-pristine-gate-attempt2.log`): **PRISTINE_MISSING_SCHEMA_CATALOG_UNCHANGED**,
exit0. O entrypoint real concluiu o inventário, importou o main real, conectou ao
Prisma e iniciou HTTP8080. A leitura de instâncias produziu o **P2021 esperado:
public.Instance não existe**. Não foram provisionadas tabelas para fazer esse
teste parecer operacional. Observação até esse ponto: **104.026ms**; não é
benchmark isolado do import, inclui start/scan/poll/exec Docker.

- Catálogo SQL before/after: transações READ ONLY sobre pg_catalog; esquemas,
  relações, colunas, constraints, funções (metadados sem corpos), tipos,
  triggers e extensões não-sistema selecionados. SHA256 idêntico:
  `b3f4317acf7c9e0990e44e5c9e122ff7c344b785183f1991e1980232d48784b7`.
  Zero relações de usuário antes/depois, zero keys Redis depois. Nenhum registro
  de tabela de usuário foi exportado. **Isto não é backup/dump/restore**.
- PG com log_statement=ddl; janela desde antes do start da engine até sua parada:
  **zero statements DDL registrados**. Esse sinal complementa o snapshot final,
  sem afirmar cobertura universal de DDL transitório/roles/database-level fora
  dos objetos e da janela observados.
- Scan dos logs brutos em memória, antes de sanitizar: nenhuma URI/credencial
  canária divulgada. Só linhas allowlisted/sanitizadas são salvas no segundo
  gate; stdout contém protocolo de resultado, nunca logs brutos. Arquivos
  engine-sanitized.log mostram Prisma ON/HTTP ON e P2021; nenhum desses sinais
  equivale a readiness de uma instância WhatsApp.
- Amostra após P2021: engine **373,4MiB/512MiB**, PG66,96MiB/192MiB,
  Redis3,695MiB/64MiB; OOMKilled=false. Engine foi parada e seu estado parado
  confirmado **antes** do catálogo after. Docker stop com janela10s terminou em
  **exit137**: não comprova encerramento gracioso; não foi confundido com OOM
  ou teste de retomada/custódia. Startup/memória/shutdown continuam riscos.
- Cleanup: os três containers e a rede nonce foram confirmados removidos em
  cleanup.log. **Os tmpfs foram descartados; o banco não foi preservado após o
  teste.** A evidência forense preservada limita-se ao catálogo SQL selecionado,
  protocolos, logs sanitizados e métricas. Volumes/DBs anteriores intactos.

Gate aprovado somente para a observação delimitada de schema ausente e catálogo
inalterado. OperationallyReady=false e ProductionApproved=false estão no
report.log. Continuam sem prova: engine com schema provisionado/saudável,
instalação do journal, ownership/custódia durável, sessão/número/mensagem,
shutdown gracioso, equivalência com engine produtiva e release/registry.

Ack revisou script e outputs após a execução somente por leitura; não encontrou
P1/P2 residual ou afirmação sem prova. Confirmou igualdade dos catálogos (o SHA
do protocolo usa texto.trim sem newline), P2021 e limites de memória/shutdown.
Não executou runners; o parecer limita-se a esse gate, sem aprovar produção.

## Design aprovado — 02/11/2026

O incremento também registra `engine-build.test.mjs` explicitamente na CI e no
workflow de imagens, com heap128 e execução serial. São contratos unitários de
contexto/entrypoint, sem boot Docker da engine. As listas anteriores de
`test:origin-journal` não incluíam esse novo arquivo. Os gates manuais Docker e
PostgreSQL prístino continuam separados; sucesso da CI não os substitui. A CI
do novo SHA da branch precisa terminar antes de qualquer aprovação desse SHA.

O core Broker segue sua release independente. Este incremento fecha a receita de
imagem derivada da fonte Evolution `fa09d37892cdbb1d65a250155d293d92230c5b30`,
com sete overlays e runtime JRC existentes, sem editar esse upstream. Ownership
continua `UNPROVEN`; imagem construída não comprova custódia ou sessão real.

A materialização reutiliza `build/stage-engine.mjs` e acrescenta um modo explícito
de contexto de imagem. Uma allowlist de arquivos versionados fornece Prisma,
public e manager. A receita própria e os scripts de imagem vêm de
`infra/evolution/`. Não copiar `.env`, helpers Docker upstream, credenciais,
sessões, node_modules ou saída compilada anterior. Conferir pin e árvore limpa do
vendor; inventariar todos os insumos copiados com SHA-256. Recusar symlinks e
limitar limpeza ao diretório de staging criado, nunca a workspace ou vendor.

Dockerfile multistage com a mesma base Node 24.19.0 por digest de infra/app.
Instalação pelo lockfile, client Prisma PostgreSQL gerado por CLI direta com URI
estritamente sintética (sem conexão/DDL), depois `tsc --noEmit && tsup`. Copiar
client gerado, dist/translations, public/manager, schema, runtime, licenças e
proveniência. Registrar também inventários dos artefatos finais; não apresentá-los
como assinatura de imagem ou revisão independente.

O entrypoint Node é próprio, sem deploy/migrate/provision/seeds/backup. Valida
proveniência e integridade da candidata antes de importar dist/main.js.
`JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED` tem padrão `false`. `true`, valores
inválidos, ownership adulterado ou proveniência ausente falham antes de qualquer
import da engine. Não existe variável para aprovar ownership. Sem captura, o
runtime legado ainda precisa de schema e configuração próprios previamente
preparados; essa receita não os prepara.

Alternativas descartadas: Dockerfile upstream (migra no startup e não instala
runtime JRC); editar upstream (quebra pin/reprodutibilidade); ativar host produtivo
(ownership/instalador não comprovados). Contexto isolado é a escolha aprovada.

## Plano de implementação

- [x] RED: materialização atual não entrega Prisma/public/manager/receita final.
- [x] GREEN: contexto fechado por allowlist, proveniência completa e limpeza segura.
- [x] RED/GREEN: executar entrypoint e recibo de build com insumos controlados;
  verificar padrão false, rejeição true/adulteração antes de carregar main.
- [x] Regressão leve serial da família engine/proveniência/staging, heap 128 MiB.
- [x] Auto-revisão de diff; registrar comandos, resultados e limites. A revisão
  independente continua com a raiz e não é substituída por esta auto-revisão.
- [x] Em janela coordenada: build integral da imagem, client Prisma dessa candidata
  e typecheck/tsup.
- [x] Gates da imagem final sem rede/PG: metadados/artefatos reais e recusas do
  entrypoint com canários controlados. Não são boot da engine ou sessão real.
- [x] P2 posterior: inventário completo de dependências e regressão Node46/46.
- [x] Rebuild e novos gates físicos após P2; validar o ramo POSIX de bins em slot
  Linux. A imagem d4 anterior não contém essa correção.
- [x] Exercício do entrypoint com a engine real e PostgreSQL isolado prístino;
  P2021 esperado/catálogo inalterado, sem readiness operacional.

Revisão: copiar apenas arquivos permitidos; provider fixo PostgreSQL; nenhum
segredo em build args/logs; assets e avisos legais preservados; captura sem atalho;
entrada falha antes de auth/rede; limpeza não segue junction/symlink. Sem commit,
push, workflows, provisionamento ou mudança produtiva nesta tarefa.

## Uso do contexto (build ainda depende de janela coordenada)

Executar na raiz do Broker. O contexto pode ser criado sem Docker, instalação de
dependências ou acesso ao banco. O comando antigo `stage-engine.mjs` conserva sua
saída de fontes; o novo comando abaixo é o contexto completo de imagem:

```powershell
$env:JRC_ENGINE_GIT_EXECUTABLE = (Get-Command git).Source
$engineStage = node integrations/evolution-origin-journal/build/context-engine.mjs | ConvertFrom-Json
# Apenas na janela de build autorizada:
docker --context desktop-linux build --platform linux/amd64 --progress=plain --label jrc.task=engine-build-20261102 --tag jrc-evolution-engine:lab-20261102-ea7dc741 $engineStage.directory
```

O override do executável Git é somente do materializador e é passado a execFile
sem shell. Neste host, `spawn('git')` encontra uma instalação local que retorna
EPERM; o Git bundled resolvido pelo PowerShell funciona por caminho absoluto.
Essa tentativa não foi RED de produto. Sem Git executável, pin/árvore limpa não
podem ser comprovados e a materialização falha.

Não construir este Dockerfile com o checkout inteiro como contexto. A cópia
gerada contém exclusivamente os insumos declarados no manifesto, incluindo
Prisma, assets upstream e receita própria. Geração Prisma usa `RUN --network=none`
e conexão sintética de build em loopback:1; não executa query, deploy ou migration.
O schema PostgreSQL gera o client desta candidata. O build final exige client
gerado, biblioteca nativa Linux, main, traduções, arquivos legais e assets;
`record-build.mjs` verifica os hashes dos insumos antes de registrar seus hashes
finais. O recibo é inventário verificável, não assinatura ou prova de ownership.

`jrc-origin-provenance.json` e `jrc-engine-build.json` ficam na imagem junto com
LICENSE/NOTICE/TRADEMARKS, manager/public preservados e runtime/schema JRC. O
startup verifica recibo, hashes e conjunto dos artefatos antes de importar main.
Somente `false` é aceito para captura; `true` falha mesmo que exista variável com
nome de aprovação. PostgreSQL é o único provider desta receita. O processo usa
USER node e os diretórios store/instances/temp próprios; nenhuma sessão é copiada.

## Evidência TDD e regressão leve

Node observado: v24.19.0. Comando focal:

```powershell
$env:JRC_ENGINE_GIT_EXECUTABLE = (Get-Command git).Source
node --max-old-space-size=128 --test --test-concurrency=1 integrations/evolution-origin-journal/tests/engine-build.test.mjs
```

- RED inicial: 1 passou/2 falharam, 9.611,4467 ms, exit1. Falta de Prisma no
  contexto foi uma assertion funcional; o segundo caso mostrou o entrypoint
  próprio ausente (MODULE_NOT_FOUND), ainda sem prova do guard.
- GREEN inicial: 3/3, zero skips/falhas, 64.609,8719 ms, exit0.
- RED adicional de limpeza: 1 passou/1 falhou, 22.218,4077 ms, exit1. A limpeza
  antiga aceitava junction e removia o target descartável de teste. A correção
  recusa alias e confere o pai físico antes de remover qualquer diretório.
- RED adicional de assets: 1 falha, 9.741,3889 ms, exit1. Uma raiz public
  redirecionada por junction passava no inventário antigo (exit0 inesperado).
  A correção recusa raiz simbólica antes da enumeração.
- GREEN focal final: 5/5, zero skips/falhas, 84.656,2966 ms, exit0. Inclui
  receipt ausente, padrão false, flag inválida/true, tamper de main, ownership
  adulterado, assets redirecionados e exclusão de configuração/helpers upstream.

Regressão final sem Docker/PostgreSQL/instalação/compilação integral:

```powershell
node --max-old-space-size=128 --test --test-concurrency=1 integrations/evolution-origin-journal/tests/engine-build.test.mjs integrations/evolution-origin-journal/tests/engine-host-lifecycle.test.mjs integrations/evolution-origin-journal/tests/unit.test.mjs integrations/evolution-origin-journal/tests/provenance.test.mjs integrations/evolution-origin-journal/tests/engine.test.mjs integrations/evolution-origin-journal/tests/staging.test.mjs
```

Rodada anterior à revisão do CLI/fechamento: **36/36, zero falhas/skips**,
exit0, 88.758,9149 ms. Aviso experimental
já existente de stripTypeScriptTypes. Há sobreposição com o focal; não somar como
testes únicos. Saídas integrais constam da execução coordenada. A árvore upstream
foi consultada limpa e o pin
permaneceu fa09d378. HEAD core avançou por ação da raiz a
ea7dc741d0c63792a969dddeac2bd35b6cbdf514; este incremento está independente e não
commitado, fora da imagem core publicada pela raiz.

Os artefatos `PROCESS_ONLY`, client marcador e arquivo .so de teste são
**fixtures sintéticas não executáveis** para verificar o guard do entrypoint e a
integridade. Não provam geração Prisma, typecheck, boot da Evolution, auth, sessão,
captura, custódia ou integração PostgreSQL. As classes pinadas de outros testes
também substituem dependências externas; continuam com seus limites anteriores.

Revisão adicional anterior ao build pesado:

- O CLI real revelou ciclo de importação com top-level await (exit13). RED
  processual: 1 falha/418,3051 ms; separação CLI/context-inputs; GREEN1/1,
  18.976,3842 ms. A API sozinha não exercitava a execução do arquivo CLI.
- O recibo aceitava asset acrescentado após staging. RED1/1 falha,
  32.518,9078 ms; o guard agora compara o conjunto e hash de source/assets/runtime
  de entrada, além de conferir alterações nos arquivos existentes.
- Na primeira regressão dessa correção houve 36 passes/1 timeout do processo de
  I/O (10s, statusnull), zero skips, 137.428,551 ms. O prazo de I/O de fixture foi
  aumentado para 30s (CLI 60s); assertions e exigência de exit0 foram preservadas.
  Focal: 1/1, 17.389,2219 ms, em build/engine-build-receipt-green.log.
- **Regressão final atual: 37/37, zero falhas/skips**, exit0, 152.960,6471 ms,
  em build/engine-build-regression-final.log. Mesmo comando serial de seis files,
  com heap 128MiB e aviso experimental já registrado. Não somar rodadas sobrepostas.

O teste de ausência do entrypoint começou como MODULE_NOT_FOUND; não foi
apresentado como RED semântico de ownership. Os REDs de junction, asset extra e
CLI, e seus GREENs posteriores, são reproduções separadas.

## Build local autorizado: concluído

Depois da coordenação serial com a raiz foi confirmado Docker Desktop local:
contexto desktop-linux, endpoint npipe DockerDesktopLinuxEngine, memória total
4.018.794.496 bytes (3,743GiB) e containers existentes aproximadamente 1,65GiB.
Nenhum outro serviço foi parado/alterado. O build limita o heap Node a 1536MiB.

O contexto foi regenerado após as correções: 309 insumos, ownership UNPROVEN e
captureDefault=false. Metadados completos em build/engine-build-context.log.
O build local usa a tag/label do comando acima e log build/engine-image-build.log;
build/engine-image-id.log só representa artefato se o comando terminar com êxito.
A consulta inicial ao pipe Docker no sandbox foi negada; acesso local autorizado
foi obtido para o build. Nessa etapa não houve publicação nem boot da engine/PG.
Os gates sem rede/PG posteriores estão registrados abaixo. O slot de boot real/PG
permanece separado e exige nova coordenação.

A primeira tentativa foi cancelada por decisão de execução, não por falha do
produto ou OOM: o runtime completou a instalação em 284,1s, mas o builder
baixava novamente os mesmos pacotes em conexão muito mais lenta (8MB em aproximadamente
101s). Foi interrompido somente o filho Buildx identificado por PID/pai/tag/contexto
exatos; nenhum builder global ou outro serviço foi parado. O log dessa tentativa
foi preservado em build/engine-image-build-first-cancelled.log. A receita usa agora
uma camada system comum e o builder instala apenas Git adicional. A segunda
tentativa confirmou cache dessa camada e avançou a npm ci. Nenhum resultado
intermediário deve ser apresentado como imagem final válida.

O build seguinte executou npm ci (1123 pacotes), gerou o Prisma Client6.19.0
com rede desabilitada, passou no tsc e gerou CJS/ESM por tsup, mas falhou no guard
do recibo após npm prune: `ORIGIN_ENGINE_IMAGE_INPUT_CHANGED`. Nenhuma imagem
final de runtime foi produzida por essa tentativa. Log preservado em
build/engine-image-build-input-failed.log.

Diagnóstico somente de nomes/hashes em camada compilada cacheada confirmou
package-lock.json como único input divergente:

- Original: `86660862bf3e58ed20ea5a339b9656fcdf2e3f638deaa726712460a6d7e7e7fb`.
- Após a etapa: `df0d1646d469679afddff0b117a48db00dc5c46533f5c398a9fc352fb6233af9`.

O guard não foi relaxado nem o manifesto refeito para aceitar a mutação. A poda
agora usa `--no-save`, configuração que impede gravação do lockfile sem desativar
sua leitura. Referência: [npm v11 — save](https://docs.npmjs.com/cli/v11/using-npm/config/#save).
Uma retentativa com contexto novo confirmou o hash original e concluiu o recibo.
A imagem de diagnóstico `jrc-evolution-engine:diagnostic-20261102`
é de build, não de runtime, não foi executada e não prova engine operacional.
Sua exportação/desempacotamento levou 498,5s; log em build/engine-image-input-diagnostic.log.

Avisos reais da compilação: emitDecoratorMetadata sem SWC e import.meta na saída
CJS para o helper `installOriginJournal` de journal.mjs:27. O bootstrap não chama
esse instalador; não houve execução desse caminho nem prova de falha runtime.
Esses avisos não autorizam declarar bootstrap/ownership nem equivalência com
saídas de outro ambiente. Nenhum src/runtime host foi alterado para suprimi-los.

A consulta CIM posterior, com acesso local autorizado, confirmou host de
8.219.628KiB (~7,84GiB), com 334.724KiB (~327MiB) livres nessa amostra; disco C
25.392.472.064 bytes livres. Não houve OOM observado e nenhum serviço foi removido
ou parado. O custo de I/O não deve ser confundido com falha semântica dos testes.

Resultado final do build: **exit0**, usando a receita com camada system comum e
`npm prune --no-save`, contexto regenerado com 309 insumos. Prisma Client6.19.0
foi gerado novamente offline; tsc/tsup passaram; recibo passou em 9,5s. A cópia de
node_modules levou 129s e a exportação/desempacotamento final 182s. Nenhum OOM foi
observado. O build não executou app, schema deploy, seeds, backup ou migração.

Inspeção local somente leitura após conclusão:

| Campo | Valor observado |
| --- | --- |
| Tag local | jrc-evolution-engine:lab-20261102-ea7dc741 |
| IID e inspectId (índice OCI) | sha256:d4aacdba62c1fc9e5d3892bb5736cdf2b58f9a1787d04434da1309805683f848 |
| Manifest de plataforma | sha256:bb278d79ad5a21b23e8a44d7447087d0acad3299b4e8f54a9fb7c7d2a1046492 |
| Config | sha256:c379b9b278fd425174e3b71e4fdf53c826ca9a556a195c851354ffaf00b75f2b |
| Arquitetura/OS | linux/amd64 |
| Tamanho | 465.082.413 bytes |
| Usuário/working directory | node / /evolution |
| Entrypoint | node jrc-image/entrypoint.mjs |
| Ambiente selecionado | NODE_ENV=production; DATABASE_PROVIDER=postgresql; JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED=false |
| Ownership/source/task | UNPROVEN / fa09d37892cdbb1d65a250155d293d92230c5b30 / engine-build-20261102 |

O RepoDigest local também usa d4aacdba, mas é metadado do armazenamento local:
**nenhum push GHCR/registry, deploy, commit ou atualização produtiva ocorreu**.
Não é evidência de imagem publicada. O código permanece não commitado e esta
tag com sufixo ea7dc741 não significa que o core desse commit inclua o incremento.

## Gates históricos da primeira imagem sem rede/PG — 4/4 (antes do P2)

Execução manual explícita, heap do driver 128MiB:

```powershell
$env:JRC_ENGINE_DOCKER_EXECUTABLE = (Get-Command docker).Source
$env:JRC_ENGINE_IMAGE_GATE_ID = (Get-Content integrations/evolution-origin-journal/build/engine-image-id.log -Raw).Trim()
node --max-old-space-size=128 integrations/evolution-origin-journal/tests/engine-image-gates.mjs
```

Após coordenação adicional com a raiz, foram executados quatro casos seriais
na imagem imutável acima, com network=none, cap-drop=ALL, rootfs read-only,
no-new-privileges, limite 192MiB/1CPU por container e prazo 20s por caso. Cada
container recebeu label jrc.task=engine-build-20261102 e nome único. O caso de
contrato usa somente um leitor Node de metadados, nunca importa main da engine.

| Caso | Evidência observada |
| --- | --- |
| Contrato original da imagem | UID real 1000; Node24.19.0; client6.19.0; cabeçalho ELF nativo; source/receipt hash e conjunto/hashes de 245 artefatos reais conferidos. Configuração de usuário e entrypoint da imagem também conferida. |
| Captura true | Entrypoint real retorna exit1/ORIGIN_ENGINE_OWNERSHIP_UNPROVEN, mesmo com variável de aprovação aparente. Nenhuma saída de main e nenhum canário divulgado. |
| Flag inválida | Exit1/ORIGIN_ENGINE_STARTUP_REFUSED, sem import do canário ou divulgação de URI. |
| Recibo adulterado | deliveryOwnership alterado para PROVEN foi rejeitado com exit1/ORIGIN_ENGINE_STARTUP_REFUSED antes do import. |

Resultado final: **4/4, exit0** do executor. Logs sanitizados:
build/engine-image-gates.log e build/image-gates-cbeddc53dc/report.log, mais outputs
por caso. Esses caminhos usam a raiz integrations/evolution-origin-journal/.
O driver registra entradas sintéticas separadas dos outputs dos containers.
Nenhuma ENV produtiva ou credencial real foi fornecida ou copiada.

Nos três casos de recusa, o main é substituído por um canário inofensivo via mount
read-only; o recibo de controle tem seu hash correspondente ajustado para evitar
que uma falha irrelevante de checksum mascare a admissão. Se a proteção fosse
contornada, só o canário imprimiria um marcador e terminaria, sem I/O. O teste de
recibo altera seu campo de ownership; não é prova de assinatura criptográfica.
As saídas brutas foram verificadas quanto à ausência do canário antes de gravar
logs sanitizados. Não houve boot da Evolution, conexão a banco, DDL, sessão,
número, mensagem ou acesso à rede externa.

A primeira versão do executor falhou por escape de regex no leitor, e a revisão
seguinte revelou uma corrida do cleanup com --rm que ocultava o resultado do
probe. Foram corrigidos no harness, sem alterar a imagem. O leitor compara todo
o conjunto/hashes em uma única passagem; a cleanup aceita remoção automática
após stop e só opera sobre nomes/labels desta tarefa. Essas tentativas não são
RED do produto nem evidência de falha da imagem. A execução final confirmou os
quatro casos acima. Consulta final por label confirmou zero containers desses
gates. Oito arquivos JavaScript passaram em node --check, git diff --check não
apontou erros, vendor permaneceu limpo no pin fa09 e o HEAD core permaneceu EA.

## Baseline produtiva diferente: equivalência não verificada

A raiz forneceu observação somente leitura do Dokploy, em 02/11/2026:

- configuredImage:
  `evoapicloud/evolution-api:v2.3.7@sha256:1bd8afc4a6cf48822e6cf02469aeae7bd35a12a6b616eacd1291926307f4d339`.
- imageId:
  `385a3c4bedf42c66b46b43d06aae8712620144a84aa3b2c831b30c68435ab27c`.
- OCI revision: `cd800f2976e1e5b682fbf86a01ee4d85ae61f370`.

Esta candidata usa Git pin `fa09d37892cdbb1d65a250155d293d92230c5b30`.
O rótulo 2.3.7 não estabelece equivalência entre esses artefatos. Não foi
atualizada engine produtiva nem coletada/exposta configuração sensível nesta
comparação.

Consulta Git local, sem fetch e sem alterar upstream: o objeto cd800f existe;
repositório não shallow; cd800f é ancestral de fa09, com seis commits no intervalo;
fa09 não é ancestral de cd800f. Não há diff nos sete arquivos dos seams, Dockerfile,
package.json, lockfile ou Prisma entre as revisões selecionadas. O diff global
inclui `.gitmodules`, CONTRIBUTING.md, LICENSE, NOTICE, README.md, SECURITY.md,
TRADEMARKS.md, o gitlink evolution-manager-v2 e public/hover-evolution.png.

Isso é comparação de árvores Git, não comprovação do conteúdo ou comportamento
da imagem produtiva. **Equivalência de artefato NÃO VERIFICADA**: manter gate
adicional de proveniência física e compatibilidade de assets/schema/client e
runtime antes de cogitar substituição. Não mudar o pin, inferir ownership, migrar
ou reiniciar a engine real com base apenas nessa ancestralidade.

## Checkpoint atual e gates que continuam pendentes

1. Coordenar janela Docker serial antes de novo build/PG. Amostras antigas de
   RAM/disco neste documento são históricas, não disponibilidade atual.
2. O artefato f670 teve schema descartável explicitamente provisionado, boot
   real vazio, HTTP autenticado200, scan completo66788ms e shutdown1461ms/exit0.
   Seus quatro gates finais de admissão passaram; o leitor final levou160662ms.
   O P2021/startup~104s/stop137 das seções anteriores é histórico e foi superado
   nesse caso vazio. Não representa sessão WhatsApp nem prontidão produtiva.
3. Os dois crashes Linux de custódia usaram módulos da imagem f670 com
   engineMainImported=false; são separados do boot real. Falta provar o hook
   de captura no main real, criação de instância e receptor sintético privado.
   Captura true continua recusada no entrypoint produtivo.
4. As fontes posteriores têm 11 overlays, corrigem a identidade antes do init,
   compartilham o host entre avaliações e removem o console incondicional de
   notify. Regressão focal22/22 GREEN; nova imagem e gates físicos ainda pendentes.
   Não reutilizar os gates de f670 para certificar essas fontes.
5. Revisão independente e gates CI do diff antes de qualquer integração da
   candidata. Nenhum novo workflow, publicação ou substituição de engine
   produtiva foi feito. Nenhum número/sessão/mensagem foi ativado.

O npm test completo e a revisão de integração são coordenados pela raiz.
Não foram comprovados os marcos50/400/900, equivalência produtiva, instalação
do host produtivo, ownership operacional, shutdown de sessões, CI/publicação
ou assinatura. Os resultados acima são laboratório local e dados sintéticos;
nenhum número/sessão/mensagem real foi ativado.
