# P2 D — Evidência incremental do transporte central

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
