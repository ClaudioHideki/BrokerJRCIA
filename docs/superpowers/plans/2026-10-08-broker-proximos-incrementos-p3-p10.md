# Broker — próximos incrementos do programa P3–P10

O programa mestre de 05/10 continua vigente. Este roteiro detalha lacunas confirmadas na leitura do código e mantém entregas funcionais pequenas, revisadas e publicadas na main. Ele não substitui testes, publicação ou homologação. O primeiro corte em validação contém espera, horário, importação com credenciais locais, saída observada do aparelho, pools configuráveis, diagnóstico e registro offline de aceite.

## P3 — completar as famílias de blocos

1. **Ações e mídia:** reutilizar o transporte e os serviços de atendimento existentes para etiqueta, atributo, nota, resolução e mídia. Cada ação precisa de schema, formulário, validação, simulação sem rede e efeito durável identificado por execução/versão/ciclo. Revalidar autoridade humana antes do efeito e definir reconciliação quando o resultado remoto for incerto. Não anunciar o nó pelo formulário isolado.
2. **Captura e subfluxos:** finalizar caminhos de entrada inválida, expiração e saída; fixar versões de dependências publicadas, limitar profundidade e recursão, manter estado após reinício e impedir mistura entre tenants. O simulador deve usar os mesmos contratos.
3. **HTTP e IA:** concluir somente capacidades delimitadas do catálogo aprovado, com credencial selecionada no tenant, limites de tempo/tamanho/custo, validação de destino e saída sanitizada. Importação não transfere credenciais do autor. Falha, timeout, cancelamento humano e consumo precisam aparecer na execução.

Aceite local: teste de cada porta de saída e erro pelo motor canônico, persistência e retomada após substituição de worker. Aceite real: os mesmos nós na jornada da caixa conectada, sem executor paralelo na central.

## P4 — confirmar a sincronização do aparelho

Publicar o ledger de tentativas e observações após os gates completos. Homologar texto e mídia do aparelho, eco antes/depois do ACK, reinício, resultado UNKNOWN, abandono explícito e exclusão em andamento. Correlacionar apenas por ID do provedor. Uma observação sem prova de autoria não identifica um agente; um timeout não comprova envio. A classificação externa não cria outbox nem reenviará a mensagem ao WhatsApp.

## P5 — grupos por conexão

**G1, catálogo e seleção:** adicionar adaptador QR e catálogo persistido por organização/canal/JID de grupo. Usar `group/fetchAllGroups` da Evolution sem inventar paginação remota: resposta e duração limitadas, snapshot local e paginação local. Após I/O fora da transação, revalidar lease, revisão e identidade do número antes de publicar o snapshot. Falha ou resultado parcial preserva o catálogo anterior como desatualizado; não vira lista vazia. Seleção de grupo é explícita e automação fica desligada por padrão.

**G2, participantes e eventos:** ingerir eventos de grupos/participação com deduplicação, guardar autoria e participação do próprio número, invalidar a seleção se ele sair. Entrada por convite e saída usam operação durável e reconciliação UNKNOWN, sem repetição cega. O número deve ser observado independentemente da saúde do Chatwoot para o modo standalone.

**G3, conversa e Flow:** criar destinatário discriminado `GROUP`/`INDIVIDUAL`, preservando JID do grupo e autor participante. Não transformar grupo em contato telefônico. Aplicar opt-in, gatilho explícito, limites e regras de grupo de anúncios; o adaptador da central precisa conservar essas informações. Testar grupos com JIDs iguais em tenants/canais diferentes, remoção do número, evento atrasado e mensagem enviada pelo aparelho. Meta e transporte CENTRAL dependem de capacidade comprovada do provedor.

## P6 — voz

**V1, viabilidade por perfil:** registrar provedor, versão, elegibilidade dos ativos e capacidade real da central; realizar uma chamada com áudio bidirecional. O código upstream examinado contém sinais de chamada, mas não prova um caminho completo de áudio. Depois da prova, implementar controlador de sessão, concorrência, autorização e registro. Um botão, evento de oferta ou resposta HTTP não encerra P6. Os perfis sem suporte comprovado continuam explicitamente sem voz.

## P7 — administração existente

Validar A1–A8 com uma matriz por papel, organização e caixa: cadastro, membership, módulos, planos/limites, credenciais, suporte, auditoria e exclusão. Completar somente lacunas observadas, conservando os serviços existentes. Exercitar revogação com tela aberta, mudança de papel, último OWNER e exclusão com operação incerta. Relatório administrativo não pode ampliar autoridade sobre dados de outra empresa.

## P8 — operação e capacidade

1. **C2, mídia privada:** substituir o caminho atual de bytes no PostgreSQL por backend privado S3 compatível com MinIO, metadados no banco, limites por tenant, upload/stream limitado, leitura autorizada e limpeza durável. Manter compatibilidade de mídia histórica; URLs públicas permanentes não são evidência de isolamento.
2. **C3, distribuição QR:** tornar o destino Evolution configurável por motor e persistido por instância, com roteamento de webhook autenticado, leases, reconexão controlada e resultado incerto reconciliável. Não alterar destino de uma conexão física existente implicitamente.
3. **C4, medição:** observar hardware/topologia, conexões físicas, mensagem/mídia por segundo, picos, latência, filas e justiça entre tenants. O teste lógico de 500 empresas e 10.000 canais não mede sessões WhatsApp nem throughput. Ajustar pools por réplicas ao orçamento real do PostgreSQL.
4. **C5, recuperação:** backup consistente de PostgreSQL, Redis, objetos e configuração privada; restaurar em ambiente isolado e demonstrar recuperação sem perda nem resposta duplicada. Ensaiar queda do provedor, reinício e tempestade de reconexão antes da expansão comercial.

## P9 — Flow e QR delegados na central

**F1, fonte do host:** em 08/10, `git ls-remote` confirmou `codex/global-quick-actions-20260930` em `80f7305ad0eac310d661071856f67a7e048881de`, no repositório `ClaudioHideki/jrc-conversas-nico-v12-2-7-comercial-integrado`. O commit foi buscado para leitura, preservando o checkout. Comparar seus módulos e depois a imagem instalada; ter o objeto Git não comprova implantação no servidor.

**F2, autorização:** reutilizar o BFF e os grants de Conexões para QR. Criar sessão curta própria para Flow, separando leitura, edição, publicação e vínculo, com escopo persistido por caixa inclusive em rascunhos. Resolver Account/Inbox/integração/canal no servidor e revalidar membership após I/O. Alteração de fluxo compartilhado exige autorização sobre todo o alcance.

**F3, interface comum:** consumir catálogo, contrato, validação, simulação e serviços do Broker pelo editor delegado; integrar a navegação Rails da fonte confirmada. A configuração por URL/Account/token do Chatwoot externo não exige acesso ao servidor da empresa nem utiliza credencial global de outro tenant.

**F4, executor único:** cutover por caixa/revisão com drain e rollback. Listener, dispatch, resume, recovery, jobs antigos e ambos os runners Rails devem obedecer ao proprietário. O migrador `BROKER_FLOW_V1` existente não comprova migração nem parada dos `jrc_flows` Rails.

## P10 — instalação, jornada e piloto

Depois do CI e das imagens do mesmo SHA, fornecer guia Dokploy e aplicar a cadeia de migrações correspondente. Verificar imagens efetivas, schema, workers, configuração e transporte. Executar H01–H24 conforme perfil em standalone, JRC tenants A/B e Chatwoot externo, após P9. A primeira jornada real é conexão → mensagem recebida → menu/captura → transferência humana → resposta → retomada coordenada.

Registrar versão, configuração, correlação e resultado observado. Os tenants adicionais foram adiados pelo usuário até esta etapa. O registro offline ajuda a organizar evidências, mas não aprova homologação automaticamente. Fechar o piloto somente após os incidentes serem resolvidos e repetidos os cenários afetados.

## Incremento de usabilidade — 09/10/2026

A configuração por caixa passa a orientar conexão, publicação, vínculo do bot e teste de atendimento. A navegação conserva o retorno à caixa e a retomada explica as três opções existentes sem reativação automática. Uma leitura que falha não permite alterar o vínculo usando o estado anterior. Evidências em `docs/validation/2026-10-09-bot-setup-journey.md`: build, 117 testes focais e 2.405 testes globais aprovados, revisão sem achados críticos ou importantes pendentes.

Este incremento não altera Compose, ENV ou a baseline 0051. Os candidatos de mídia privada, grupos com Flow e módulos delegados continuam separados até integração, CI e imagens correspondentes. O aceite de produção permanece pendente da jornada real controlada.

## Incremento C2 — 09/10/2026

Mídia privada durável foi integrada ao checkout canônico com a migração 0052, preservando o backend PostgreSQL padrão e o histórico inline. Build e 2.534 testes globais passaram; 71 testes dos arquivos de banco reparados passaram. O CI e o workflow de imagens passam a exigir o gate de armazenamento real com MinIO fixado. [Evidências C2](../../validation/2026-10-09-private-media-c2.md) e [guia de operação](../../operations/private-media-minio.md).

Essa entrega não instala MinIO, não migra objetos entre destinos e não conclui C3–C5, subfluxos, G3, P9 ou P10. A release precisa de CI e imagens do mesmo SHA antes da instalação. O ensaio real de atendimento e de mídia permanece pendente.
