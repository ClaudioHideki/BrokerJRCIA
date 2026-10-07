# P2 D — Evidência incremental do transporte central

## D4 — Configuração central e substituição observada (07/10/2026)

Implementação sobre a main D3 `c02e14bf8cd5dd8a5923b80b75f9f1493ae489eb`. Verificação local final aprovada; CI/publicação serão verificados para o commit final deste incremento. Nenhuma instalação D4 realizada. As seções anteriores registram a evolução histórica e não representam o estado final deste incremento.

O canal público CENTRAL usa uma caixa existente `Channel::Api` ou `Channel::Whatsapp` da conta aprovada da empresa. Não cria instância Evolution nem ativo Meta. A preparação exige OWNER/ADMIN atual, perfil remoto administrativo, IDs e revisões observados, autorização explícita para substituir o bot existente e hash do webhook/callback anterior. Operação persistida 0048: DETACH → CREATE → ATTACH → VERIFY, com GET antes/depois de cada alteração. READY exige bot/callback/segredo próprios comprovados; o webhook original da caixa permanece intacto.

Claims de origem/conta/caixa e integração impedem concorrência entre executores. Caixa física existente, inclusive pausada, é recusada antes do primeiro POST porque mantém vínculo/histórico e constraint exclusiva. Vínculo central desativado após reversão pode ser reutilizado preservando o canal. O legado só é revogado quando IDLE e sem efeitos SENDING/UNKNOWN; sessões humanas e históricos permanecem. Bind/retry/reconcile/enable físicos não assumem um canal central.

Resultado remoto desconhecido nunca autoriza replay do POST. O operador pode cancelar uma preparação ainda não despachada (CANCELED) ou solicitar reversão observada, inclusive de uma etapa parcial. Recuperação com credencial/destino renovados usa somente a mesma origem e conta, com autorização atual, CAS, readback, fingerprints e propriedade atual; não reinterpreta uma operação em outro servidor. Lease ativo impede concorrência. Reversão interrompida também permite revalidar o contexto, conservando UNKNOWN até obter prova. Vínculo legado com credenciais/revisões antigas permanece pausado e exige configuração atual antes de voltar a executar. Bots criados permanecem na central sem exclusão automática; conversas antigas não são reassumidas automaticamente.

A tela salva a chave por empresa/revisão antes do prepare, registra o ID imediatamente, recupera por chave/ID após perda de resposta e lê a revisão atual antes da próxima decisão do usuário. Resultado tardio de outro tenant é descartado. Chaves terminais são removidas para permitir uma segunda caixa; ausência comprovada por 404 retorna à seleção. Exclusão definitiva de CENTRAL não é oferecida neste incremento; a reversão preserva recursos e histórico.

Capacidade/callback individuais pertencem ao vínculo e às revisões atuais. A automação publicada só é vinculada após receber callback autenticado dessa caixa. Isso é prova de ingresso, não prova de entrega no aparelho. Entrada e despacho conferem o bot atual da caixa e seu callback além do assignee da conversa: o próprio AgentBot é reconhecido; concorrente ou callback alterado impede execução/envio. Transferência humana mantém a prioridade e retomada usa o fluxo coordenado existente.

Revisão independente encontrou seis falhas concretas: recuperação após reconfiguração/etapa parcial; vínculo físico pausado aceito; bot atual da caixa não revalidado; perda de resposta no wizard; callback anterior alterado sem nova aprovação; exclusão CENTRAL anunciada sem suporte. Correções incluíram rotação durante reversão e reutilização da tela para outra caixa. O revisor confirmou fechamento por inspeção; não substitui os gates executados abaixo.

Evidência intermediária: 44 testes PostgreSQL focados aprovados, cinco testes iniciais da tela aprovados; regressões adicionais incluídas depois. Primeira suíte completa registrou 668 aprovados e duas expectativas antigas de baseline 0047; expectativas corrigidas para 0048. Primeira suíte unitária registrou 1.866 aprovados e três falhas de inventário/OpenAPI; inventários e artefato corrigidos. A suíte seguinte encontrou oito falhas causadas pelo registro ausente das oito rotas novas no inventário de segurança; políticas explícitas foram incluídas, mantendo o relatório histórico imutável, e 27 testes de auditoria passaram.

Resultados finais locais: **276 arquivos / 1.874 testes unitários aprovados** (349,97 s), **91 arquivos / 673 testes PostgreSQL/Redis aprovados** (366,68 s) e **dois testes compilados aprovados**. Build limpo/typecheck, OpenAPI gerado, bundle (11 arquivos/zero findings), contratos públicos, notices (sete pacotes), submódulo Evolution, audit (zero vulnerabilidades), PDF histórico, gate de auditoria e verificação de release (247 rotas/zero findings) aprovados. Diffcheck e revisão independente sem bloqueios. Não repetida E2E local completa; navegador/container/restauração serão verificados no CI do SHA final. Roteiro: [instalação e homologação D4](2026-10-07-broker-d4-instalacao-homologacao.md).

**Homologação externa/servidor: NOT_RUN.** D2 é a instalação anteriormente confirmada pelo operador, baseline 0046/true. Não houve instalação D3/D4. HTTP remoto de laboratório é sintético. JRC tenants A/B e Chatwoot externo serão preparados ao final conforme decisão do usuário. Meta real, mensagens enviadas pelo aparelho, grupos, chamadas, módulos embutidos QR/Flow, S3 e capacidade de 500 empresas/10 mil conexões continuam nas fases próprias do programa; esta entrega não as declara comprovadas.

Base ec38dcb, branch codex/broker-p2-modes-catalog-20261005. Registro de desenvolvimento local; não comprova transporte central ativado, imagem nova ou implantação.

## D1 — Limite autenticado de eventos

Novo decoder interno reutiliza HMAC sobre bytes originais e classificação existente, com contexto persistido e atual idênticos. Exige CENTRAL_TRANSPORT/READY, origem HTTPS normalizada, Account/Inbox e revisões de destino, credencial e propriedade; rejeita divergências também nos objetos aninhados. Organização recebida no payload não governa o escopo.

As identidades de mensagem incluem empresa, canal, integração, origem, Account/Inbox e conversa/message ID. Delivery ID, timestamp e revisão transitória não fazem a mesma mensagem parecer nova. Isso prepara a chave de deduplicação; a deduplicação persistida e suas corridas pertencem a D2.

Somente incoming público de contact, com texto simples e sem anexos, pode virar CONTACT_TEXT. Mensagem estruturada/mídia com legenda não vira turno de texto. UTF-8 inválido é rejeitado sem substituir caracteres. IDs em string só são aceitos no formato decimal canônico e seguro; não se infere identidade de números ambíguos.

Nota privada, resposta humana, bot externo e estado de conversa viram observações de atendimento. Elas não são reenviadas, não executam bot e não autorizam retomada. pending exige leitura canônica/reconciliação posterior. Eco é confirmado apenas pelo mapping persistido com escopo exato; atributo de payload não prova origem Broker.

O decoder não está montado em rota nem libera runtime. Todas as saídas têm mayExecute=false, mayForwardReply=false e requiresCanonicalRead=true. Persistência, autorização, envio único e cutover continuam tarefas seguintes.

## Verificações

| Verificação | Resultado |
| --- | --- |
| TDD inicial | RED por módulo ausente, observado; implementação posterior |
| Decoder + classificador existente | 88 testes aprovados antes da revisão |
| Revisão independente | Uma falha importante: mídia/estrutura com content era classificada como texto; outro achado: UTF-8 inválido substituído silenciosamente |
| Correções da revisão | 5 testes falharam antes da correção; discriminação de conteúdo e decoding fatal corrigidos |
| Focados finais | 94 testes aprovados, 2 arquivos; 64 casos novos do decoder |
| Typecheck/build | Aprovados com as correções |
| Suíte completa final | 271 arquivos, 1.842 testes aprovados; 287,26 s |

Ruling de revisão: a troca silenciosa de caracteres assinados foi tratada como falha de integridade deste adaptador, além da classificação de mídia. Ambas entraram no mesmo passe de correção com RED/GREEN. Compatibilidade da versão instalada, persistência concorrente, envio/reconciliação/cutover e jornada externa não foram julgados pelo reviewer de D1; permanecem pendentes nas tarefas respectivas. Não houve download de logs privados nem nova E2E completa local.

Referência de protocolo: [webhooks oficiais](https://www.chatwoot.com/hc/user-guide/articles/1677693021-how-to-use-webhooks), consultada em 06/10/2026. Isso não valida as capacidades das instalações reais.

## Estado do programa

P2 A/B/C1/C2 têm evidências locais e commits na branch; C1/C2 estão publicados em ec38dcb. D1 é limite interno de eventos; D2–D5 e wizard integral ainda pendentes. Main 4fe35ba e suas imagens contêm correção de segurança/P1, sem os incrementos P2. Servidor e cenários reais continuam separados do laboratório e do CI.

## Correção do inventário de políticas no CI do P2

Na execução [37494508230](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/37494508230), o log fornecido pelo usuário registra 578 testes de integração aprovados e uma falha: o inventário esperava 225 políticas, mas recebeu 227. A migração 0045 cria duas políticas attendance_tenant nas tabelas local_attendance_teams e local_attendance_team_members; o inventário ainda esperava sete políticas de atendimento, sem essas duas.

A correção mantém a comparação exata do inventário e inclui ambas as tabelas na verificação independente de USING/WITH CHECK por organização, ownership jrc_migrator, ENABLE/FORCE RLS e grants. DELETE permanece negado a jrc_app em times e permitido apenas em vínculos de membros, como especificado na migração; jrc_auth e jrc_platform não recebem acesso às novas tabelas. Nenhuma migração ou permissão de produção é alterada por esta correção de teste.

Verificação local: 23 testes de migrações aprovados, incluindo a especificação ampliada; revisão independente sem bloqueios. A primeira execução unitária concorrente às integrações registrou dois timeouts de 30 segundos na auditoria (1.840 aprovados). Os seis testes de auditoria passaram isoladamente; a repetição completa com menor concorrência, sem as integrações paralelas, passou em 271 arquivos/1.842 testes (395,35 s), mantendo os limites originais dos testes.

A tentativa completa de integrações local foi interrompida após falhas em concorrência de réplicas do Dashboard App e timeout de upgrade/readiness; não é uma suíte aprovada. As duas integrações passaram isoladamente: 2 arquivos/8 testes, 13,66 s, mantendo os limites originais. A aprovação completa de PostgreSQL/Redis e das jornadas de navegador ainda depende da nova execução de CI. A falha no inventário impediu a continuação dos gates daquele CI e não comprova uma imagem P2 publicada nem instalação no servidor.

Decisão de entrega: integrar os incrementos concluídos P2 A/B/C1/C2 e o decoder interno D1 à main, reutilizando o checkout. A publicação de imagens será somente da main, após seus gates; D2–D5 e a homologação externa continuam pendentes e não são anunciados como parte funcional deste release.

## Main 2c97533 — diagnóstico autorizado do CI e retomada

O usuário autorizou o download dos logs da execução [37500993351](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/37500993351). PostgreSQL/Redis passou nessa execução. As jornadas de navegador registraram 35 aprovadas, cinco não executadas e duas falhas no cenário de retomada: desktop após reload, ao procurar Modo: Bot; celular na leitura inicial do modo humano, depois de a jornada desktop terminar antes de restaurar esse estado.

A seleção repetida do canal atual limpava conversationId e o rascunho, mesmo sem alterar channelId. Como o efeito de carregamento depende de channelId, a conversa não era recarregada. Dois testes de regressão reproduziram a perda do compositor nos modos BOT e HUMAN. A correção ignora somente a seleção do canal já ativo; uma troca real mantém a invalidação da navegação e a limpeza dos dados anteriores. Não altera autorização, atribuição, retomada remota ou controle humano.

Verificações da correção: 28 testes da tela de mensagens aprovados; jornada focada de retomada com API, PostgreSQL e Redis reais de laboratório aprovada em desktop e celular (2/2, 59,1 s), com central sintética e sem WhatsApp real. Typecheck aprovado. Suíte unitária completa: 271 arquivos e 1.844 testes aprovados (402,81 s). Revisão independente estática sem bloqueios. A suíte E2E local completa não foi repetida.

Separadamente, a execução local completa de PostgreSQL/Redis registrou 576 aprovados e três falhas QR: ausência de claim da outbox e INVALID_OUTBOX_CLAIM. O arquivo passou isoladamente (17/17, 12,77 s) e no CI da main. A diferença local ainda não tem causa comprovada; não é registrada como aprovação completa nem tratada como resolvida pela correção da tela.

Os gates da próxima main, publicação das imagens e atualização do servidor serão verificados separadamente. D2–D5 continuam pendentes.

## D2 — Persistência e ingresso pela central (06/10)

Base de implementação: main 16e5b7c50107d6cf775493e135fc99f913c79399. A migração 0046 distingue BROKER_TRANSPORT de CENTRAL_TRANSPORT, mantém os canais anteriores físicos e permite um canal central sem provider, credencial física, instância QR ou ativo Meta inventados. O vínculo identifica organização/canal/integração/origem/Account/Inbox e revisões; duas organizações não podem reivindicar a mesma caixa remota. As novas tabelas têm ENABLE/FORCE RLS, ownership jrc_migrator, políticas e grants enumerados nos testes e registro no purge.

O ingresso usa a rota de eventos já existente da integração. Resolve a organização pelo ID persistido, verifica os bytes assinados e revalida o contexto sob lock do canal. Reserva duravelmente a identidade da mensagem, materializa contato/conversa/mensagem e mappings remotos na mesma transação. Dois callbacks e a substituição do processo preservam uma única entrada. Não armazena o payload bruto.

O processamento interno lê conversa e mensagem canônicas fora da transação; depois revalida as revisões, compara IDs/texto/contato e observa o atendimento antes de chamar o router do runtime atual dentro da mesma transação. Texto histórico ou atendimento humano permanece registrado sem execução. Observação pending não retoma o bot. Não chama o executor de Flow legado.

A migração e os repositórios impedem mirror/CHATWOOT_REPLY e reserva pelo worker QR/Meta para canais centrais. O caso de reserva incorreta pelo worker físico foi reproduzido antes da correção. A prontidão estrutural passa a exigir 0046; não equivale à prontidão do transporte completo.

Compatibilidade de atualização: 0046 troca a unicidade integral de participantes por um índice parcial para as conversas físicas e outro de identidade remota. O novo repositório usa a condição do índice no ON CONFLICT. O SQL anterior da API 16e5b7c, sem essa condição, não pode criar conversas no banco 0046. A instalação exige janela coordenada e todos os serviços com a API nova; retorno isolado de imagem antiga não é rollback compatível. Preservar os dados anteriores no upgrade não equivale a compatibilidade com executáveis antigos. Não há instalação ou downgrade executados aqui.

Decisão de escopo: a preparação do canal e o adaptador canônico são internos neste incremento. READY no vínculo indica contexto autenticado de ingresso; não confirma capacidade de enviar ou cutover. A configuração HTTP pública, os contratos/UI e a ativação pertencem ao D4, depois do dispatcher exclusivo e scheduler do D3. A criação pública não oferece uma jornada que ainda não dispõe de saída. Não há migração automática das caixas atuais nem exposição de um segundo executor. Esta ordem deriva das Tasks 3 e 4 do plano, especialmente da regra de disponibilizar o wizard apenas com adaptador funcional.

Verificações parciais já observadas: ingresso/readiness 32 testes aprovados; upgrade 0045→0046, regressões QR, observações, inventário e prontidão local 78 aprovados; typecheck aprovado. As suítes completas e a revisão independente estão em execução; não são contabilizadas como aprovadas neste registro parcial.

Revisão independente do incremento: encontrou perda de observações humanas quando IDs eram strings decimais aceitas pelo decoder, mas recusadas ao reclassificar o payload bruto no store. Três regressões falharam com ZodError; o store agora recebe o objeto normalizado pelo decoder, preservando a assinatura sobre bytes originais. Os 25 testes do ingresso passaram após a correção; o reviewer confirmou a solução em leitura estática. Nenhum outro bloqueio D2 foi apontado. A tentativa concorrente das suítes completas registrou timeouts na auditoria e no handoff, foi interrompida e não constitui aprovação; repetição sequencial em andamento, sem ampliar limites.

A primeira correção dos IDs carregava conteúdo privado no objeto de observação. O teste D1 existente detectou a regressão durante a suíte unitária, interrompida após a falha. O objeto agora contém somente os campos mínimos de controle, sem texto, anexos ou metadados arbitrários; campanha/regra são representadas por presença booleana e o marcador de mensagem exige UUID. O controle de conversa é reconstruído a partir da classificação de ator/time/status. Decoder e classificador passaram nos 94 testes após a correção, incluindo a nota privada com conteúdo também nos atributos; o reviewer confirmou a equivalência classificatória e a remoção do conteúdo privado. A execução interrompida não é uma suíte unitária aprovada.

Observação do servidor fornecida pelo usuário em 06/10: no container consultado, /ready respondeu HTTP 200, AUTOMATION_RUNTIME_V2_ENABLED=true, destino interno evolution:8080, baseline 0045_local_attendance_directory e estruturaCompativel=true. Isso confirma disponibilidade e estrutura daquele container, sem identificar o SHA/digest instalado nem comprovar execução/entrega do bot. Não confirma a instalação de 0046. Não foi realizada implantação nesta etapa.

Verificações finais locais D2: PostgreSQL/Redis completo aprovado, 87 arquivos/615 testes (722,55 s), sem suíte concorrente. Após acrescentar a disputa entre empresas pela mesma caixa remota e usar diretório temporário do sistema no teste de upgrade, os dois arquivos focados passaram com 27 testes (44,73 s). Build limpo e execução compilada passaram; a checagem de entrypoint com banco/Redis ficou não executada por ausência das variáveis de integração nessa chamada (1 aprovado/1 skipped). A suíte unitária completa e os gates de release ainda estão em execução; nenhuma publicação ou instalação é inferida desses resultados.

Suíte unitária final D2 aprovada: 271 arquivos/1.844 testes (569,63 s), dois workers, sem PostgreSQL/Redis concorrente e sem ampliação dos timeouts. A regressão de conteúdo privado permanece coberta na suíte inteira.

Gates locais finais aprovados: typecheck, build limpo, entrypoint compilado com PostgreSQL/Redis (2/2), bundle sem achados, contratos públicos, avisos de terceiros, submódulo Evolution, OpenAPI sem alteração, npm audit sem vulnerabilidades e git diff --check. A revisão independente foi incorporada; não restam bloqueios D2 identificados. A entrega será um incremento interno na main; CI, imagens do SHA exato e instalação são etapas distintas. D3/D4 e homologação externa continuam pendentes.

## D2 instalado — evidência fornecida pelo operador (07/10)

O operador informou os digests API `0cd472e5c02853041361e0acd902e135ca378ceb023358c7491d9ac6a844a5bf` e Web `a7eaecfe1dda7cbaddb01ed3a671554452a00705fc81ad5d191fd5978e4921e2`, do release D2 da main 17832a0. O log de implantação mostra API Healthy, PostgreSQL/Redis Healthy, Evolution Running e workers de mensageria, automação, IO, scheduler e lifecycle iniciados. O probe executado pelo operador no container api retornou `0046_central_transport` e `true`, confirmando a estrutura requerida por essa imagem. Não foi feita inspeção independente dos digests dos containers em execução; a informação das imagens vem do operador. Nenhum segredo ou conteúdo do ambiente privado foi incorporado neste registro.

O primeiro comando colado estava sintaticamente alterado; uma segunda versão fornecida incorretamente configurava o cliente PostgreSQL. Esses erros não constituem falha das migrações. A consulta corrigida passou. Inicialização e estrutura não comprovam menu, entrega no aparelho, takeover ou retomada; homologação real continua pendente.

## D3 — Dispatcher central exclusivo

Migração aditiva 0047 reutiliza o ledger de recibos existente para uma reserva CENTRAL_TRANSPORT sem job MIRROR_MESSAGE. A reserva referencia mensagem, execução e versão imutáveis, origem/Account/Inbox e revisões. O worker de automação conserva ACCEPTED como enfileiramento; o worker de mensageria processa o ingresso canônico e o dispatcher central. Não há resolver QR/Meta ou fallback físico nesse caminho.

O processamento usa transações curtas para snapshot autenticado e claims, HTTP fora de SQL, revalidação do contexto antes do POST e antes de confirmar. POST aceito seguido de timeout, lease de despacho expirada ou confirmação insuficiente mantém UNKNOWN, sem repetir a mutação. A reconciliação somente lê a central. O recibo compara identidade remota, escopo, texto, estado público/outgoing, autor do token verificado pelo profile, prova opaca de 32 bytes por tentativa e mapping da execução. O callback com UUID conhecido, sem prova/autor correspondentes, conserva o controle humano.

Referência de protocolo: [lista documentada de mensagens](https://developers.chatwoot.com/api-reference/messages/get-messages). A leitura exata usa a lista limitada com before=ID+1, sem inventar endpoint de GET por ID. O [serializer de mensagens](https://github.com/chatwoot/chatwoot/blob/develop/app/views/api/v1/models/_message.json.jbuilder) não exige account_id no payload; quando ausente, o escopo é preservado pela URL autenticada e pela conversa canônica/Inbox. O [profile](https://github.com/chatwoot/chatwoot/blob/develop/app/views/api/v1/models/_user.json.jbuilder) fornece id e memberships; o [builder de mensagens](https://github.com/chatwoot/chatwoot/blob/develop/app/builders/messages/message_builder.rb) atribui outgoing ao usuário autenticado quando não se solicita AgentBot. Essas referências não provam a versão/capacidade das centrais futuras.

Revisão independente apontou três bloqueios: prova de envio insuficiente sem ACK, leituras separadas podendo misturar revisão e credencial, e preflight antigo sem backoff que bloqueava outras conversas da empresa. Dois testes PostgreSQL RED reproduziram promoção falsa para SENT e starvation; a implementação adicionou prova/autor, snapshot sob locks, lease de preflight e backoff limitado a dez tentativas. Mudanças humanas ou de ciclo/propriedade encerram reservas não enviadas; resultados já desconhecidos permanecem sujeitos a reconciliação. O teste de concorrência comprovou que a rotação espera o snapshot e que a próxima leitura recusa a revisão anterior.

Evidência parcial: 74 testes unitários de decoder/cliente/leitura canônica aprovados. Repetição focada de jornada menu/pergunta/captura/handoff e snapshot: 2 aprovados, com PostgreSQL e runtime reais de laboratório, HTTP remoto explicitamente sintético. Uma execução de 15 testes registrou 14 aprovados e timeout de jornada; a repetição focada passou sem ampliar timeout. A regressão física anterior também registrou FAILED em vez de PENDING numa execução combinada; ainda está sendo investigada. Suítes completas e nova revisão estão pendentes. Não há commit/publicação ou instalação D3.

Criação pública, wizard, exclusão observada do executor legado e cutover continuam D4. O teste de jornada utiliza uma definição de handoff publicada preparada na fixture; não prova publicação dessa definição pela tela, WhatsApp real, paridade de todos os tipos de inbox nem retomada em inbox nativa. SENT neste incremento é o estado canônico observado na central, não promessa de entrega/leitura no celular. Não autoriza migração automática dos canais atuais.

Verificações adicionais D3: 21/21 testes do dispatcher aprovados, incluindo troca de dono/destino antes e durante IO, confirmação com autor divergente mesmo portando prova e ausência de replay. Upgrade 0046→0047 aprovado (1/1), preservando eventos/vínculos centrais e recibo físico UNKNOWN. A primeira fixture de upgrade violava a constraint existente por conservar lease em integration_jobs UNKNOWN; somente a fixture foi corrigida. Não foi relaxada a constraint.

A primeira suíte unitária completa registrou 1.851 aprovados e três falhas: duas expectativas do manifesto permaneciam em 0046 e o mock de transação no teste unitário de handoff não fornecia query para o novo lock/consulta do transporte. As expectativas passaram a enumerar 0047 e o mock passou a representar uma transação física; os dez testes desses arquivos passaram. Não houve mudança de comportamento de produção para corrigir essas falhas. Repetição completa em andamento; integrações completas serão executadas depois, sem concorrência com a suíte unitária.

Verificações finais completas locais em 07/10: 272 arquivos/1.854 testes unitários aprovados (358,90 s), seguidos de 89 arquivos/642 testes PostgreSQL/Redis aprovados (367,99 s), dois workers e sem suítes concorrentes. A repetição combinada do dispatcher, jornada física e observações passou 42/42; a falha transitória anterior não teve causa demonstrada e não é anunciada como correção adicional. O reviewer confirmou em leitura estática as três soluções e não apontou outro bloqueio concreto. Estes resultados incluem isolamento com IDs remotos iguais entre empresas, concorrência, mudanças de credencial/destino/dono e proteção da tomada humana. HTTP remoto permanece sintético; não são resultados de homologação no servidor.

Gates locais finais D3 aprovados: build limpo de todos os projetos e Web, dois testes compilados com PostgreSQL/Redis, typecheck strict, bundle sem achados, contratos públicos, avisos de terceiros, submódulo Evolution, OpenAPI sem alteração, npm audit com zero vulnerabilidades e diffcheck. Entrega preparada diretamente na main. O CI completo, o build/publicação das imagens do SHA exato e a instalação no servidor são verificações separadas; nenhuma instalação D3 foi realizada. O guia de instalação mantém migração 0047 e atualização coordenada de API/workers, sem migração automática das caixas existentes.
