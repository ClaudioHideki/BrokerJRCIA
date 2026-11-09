# Configuração guiada de empresas e robôs no Broker

Data: 09/11/2026. Estado: aprovado pelo usuário para implementação, testes, publicação e implantação no Broker compartilhado, com piloto restrito à Branef. Não representa implementação ou teste físico concluído.

## Objetivo e decisão do usuário

Permitir repetir o processo para qualquer empresa autorizada: cadastrar a empresa, conectar seu WhatsApp por QR ou Meta, importar ou escolher um robô, vincular uma caixa do JRC Conversas, selecionar atendentes, testar e ativar. A operação deve usar os dados e permissões da empresa de destino, sem ajustes especiais de código por cliente.

O usuário escolheu a configuração guiada completa. Este desenho complementa o desenho de Broker independente de 05/10/2026 e preserva os contratos, o motor e as proteções existentes. A Branef será o piloto já autorizado; a generalização será testada com empresas e caixas sintéticas independentes.

## Abordagens consideradas

1. Corrigir a importação e manter conexão, integração, agentes, Flow e diagnóstico nas telas atuais. Reaproveita mais interface, mas o operador ainda precisa montar e conferir o processo em vários lugares.
2. Reunir essas etapas num assistente que coordene os serviços atuais, com importação portátil e pendências por destino. Exige estado durável e integração de interface, mas torna o processo repetível e verificável. Esta foi a opção escolhida.

Não haverá outro motor de execução nem cópia da plataforma por cliente. Os serviços atuais continuam sendo a autoridade para canais, credenciais, caixas, atendentes, versões e controle humano.

## Situação encontrada

- O onboarding QR já possui etapas duráveis de instância, canal, vínculo de caixa, atendentes e verificação. Sua interface atual solicita os agentes em outro painel.
- Meta já possui autorização por empresa, tokens cifrados e verificação de disponibilidade; sua entrada está separada do guia QR.
- O importador oferece prévia e rascunhos JRC, conversão de formatos legados e conversões parciais n8n/Typebot. Retira referências de credenciais e de alguns recursos locais, mas preserva referências de subfluxos da origem.
- A validação nativa impede usar subfluxos de outra empresa. Essa proteção deve permanecer. Um relatório de conversão estrutural exata não significa que todos os vínculos locais já estejam resolvidos.
- O cliente de sessão cancela solicitações e descarta respostas obsoletas ao trocar de empresa. A interface do assistente também precisa descartar seu contexto e conferir a empresa nas ações de gravação.
- Oito arquivos e 85 testes focados passaram nesta revisão. Esse resultado não comprova entrega real por QR ou Meta.

Referências principais: `apps/api/src/modules/integrations/chatwoot-onboarding.ts`, `apps/web/src/integrations/ChatwootOnboarding.tsx`, `apps/api/src/modules/meta-onboarding/service.ts`, `apps/web/src/pages/MetaConnect.tsx`, `apps/api/src/modules/automation-integrations/importer.ts`, `apps/api/src/modules/automations/subflow-dependencies.ts` e `apps/web/src/api/client.ts`.

## Escopo e limites

A entrega inclui a jornada no console Broker, importação e exportação de pacote nativo portátil com dependências, escolha de referências locais, diagnóstico, homologação controlada, ativação e retomada após falha ou recarga. A criação de empresa reutiliza o cadastro e os papéis atuais; o guia começa no cadastro para administradores da plataforma e na empresa autenticada para administradores da própria empresa.

QR corresponde ao transporte já instalado no Broker; Meta corresponde à conexão oficial existente. Aprovação empresarial, disponibilidade do número, permissões, pagamento e templates continuam sujeitos à Meta. Não se promete suporte a qualquer JSON: os formatos aceitos terão relatório de compatibilidade; recursos incompatíveis ou sem correspondência bloqueiam publicação/ativação com indicação do que corrigir.

Não entram voz, grupos, migração automática de números entre empresas, sincronização irrestrita de GLPI, cópia de senhas ou tokens entre clientes, alteração de licenciamento ou substituição das telas avançadas do Flow. As regras específicas do bot da Branef permanecem no seu fluxo e na configuração do Service Desk, não no assistente genérico.

## Jornada do operador

### Empresa e destino

O cabeçalho mostra a empresa atual em todas as etapas. O assistente usa o destino JRC existente ou permite configurar um destino autorizado com endereço HTTPS, conta e credencial em campo protegido. Reutiliza a aprovação administrativa de destinos e a validação de permissões existentes; não aprova hosts automaticamente.

Um administrador da empresa só configura seus recursos. O administrador de plataforma usa o mecanismo existente de atuação no tenant, com autorização e auditoria; um campo de formulário não concede permissão para escolher qualquer organização. A ausência de acesso apresenta uma pendência de acesso, sem criar outro usuário ou outra empresa silenciosamente.

### Transporte

O operador escolhe QR ou Meta e uma conexão autorizada existente, ou prepara uma nova. QR usa pareamento e confirmação de identidade atuais. Meta usa o fluxo oficial existente e suas pendências. O guia pode ser retomado após expiração ou falha, mantendo a mesma operação quando o resultado estiver incerto.

Conexão indicada como ativa pelo provedor é uma evidência de transporte, não prova de mensagem entregue ou vínculo ao JRC. Troca de número exige o procedimento de confirmação de identidade existente.

### Caixa e atendentes

Criar uma caixa API ou adotar uma caixa compatível da conta selecionada. Mostrar caixa, conta, instalação e conexão antes de confirmar. Não sobrescrever webhook de outra integração nem assumir uma caixa de outra empresa. Conflitos exigem resolução pelo fluxo existente.

Consultar agentes e equipes na instalação/conta corretas. Selecionar participantes da caixa e um destino de transferência elegível. A seleção deverá ser confirmada por leitura após a gravação. Um identificador numérico igual em outra conta não serve como correspondência. Agente removido da caixa, equipe sem membros ou destino revogado gera pendência; não há transferência declarada como concluída sem confirmação.

### Robô e importação

Escolher versão publicada da própria empresa, construir no Flow ou importar JSON. A prévia separa compatibilidade do arquivo, dependências internas e seleções de destino. Mostrar quais etapas estão completas e quais precisam de ação; não anunciar tudo compatível como equivalente a pronto para ativar.

Os textos, perguntas, condições e arestas são preservados quando compatíveis. Não executar HTTP, SQL, IA, comandos de domínio ou mensagens durante a prévia/importação. A configuração de integrações depende das permissões e do cofre atuais. Ausência de um recurso específico, como o Service Desk do destino, aparece somente nos fluxos que usam esse recurso.

### Conferência, homologação e ativação

O resumo reúne identidade do número, destino JRC, caixa, agentes, robô/versão, dependências e pendências. A verificação consulta o estado autoritativo atual. Exibe separadamente: conectado, caixa vinculada, robô publicado, homologação aprovada e atendimento ativo.

O teste automático simula o fluxo sem efeitos externos. A homologação física exige ação explícita do operador, usa a caixa de teste autorizada e uma palavra de entrada exclusiva para evitar resposta a contatos alheios ao teste. Usa o mesmo executor canônico, sem ativar um segundo bot na caixa. Caso já exista um vínculo, a troca para homologação exige confirmação com comparação da revisão atual e registro da configuração anterior.

Comprovar recebimento, resposta do bot, seleção de opção, passagem ao agente no JRC e pausa do robô quando o agente assume. O resultado fica ligado à empresa, canal, destino, caixa, identidade do número, versão do fluxo e revisões verificadas. Identificadores e tempos bastam para o diagnóstico; não incluir texto de conversas ou segredos em relatórios públicos.

Alterar uma referência relevante invalida os pontos da prova que dependem dela e exige nova conferência. Após os requisitos técnicos e teste físico do destino estarem confirmados, o operador pode ativar o gatilho definitivo. Canal sem prova física permanece como pronto para homologar, sem selo de funcionamento comprovado. QR e Meta recebem evidências separadas.

## Pacote de robô e correspondências locais

Proposta técnica: formato nativo novo e versionado, mantendo importação e exportação históricas disponíveis. O pacote inclui o fluxo raiz e o fechamento das dependências publicadas necessárias, suas versões, chaves lógicas internas e metadados de compatibilidade. Exportar somente dependências acessíveis no tenant atual; referências externas não são buscadas automaticamente.

Na importação, cada definição recebe identidade nova no tenant de destino. As chamadas internas são reescritas para as definições e versões importadas; não usar UUIDs da empresa de origem para resolver recursos no destino. Dependências repetidas são compartilhadas dentro da mesma importação; ciclos, profundidade, quantidade de versões e bytes seguem os limites existentes do motor. Arquivos e corpos HTTP têm limites explícitos e testados, sem aumentar limites só para aceitar entrada recursiva ou expansiva.

Os rascunhos do pacote são persistidos atomicamente, sem chamadas externas dentro da transação. Repetir a mesma operação idempotente devolve o resultado anterior; outro conteúdo com a mesma chave retorna conflito. Importar de novo por intenção explícita pode criar outra cópia claramente identificada, nunca reutilizar nomes como prova de identidade.

Credenciais, canal, mídia, etiquetas, atributos, destinos humanos e referências de comandos de domínio são seleções locais pendentes. Tokens não são exportados nem copiados. Os requisitos são tipados por nó e caminho de campo, preservando os dados comuns de negócio. O plano de execução define o esquema e sua compatibilidade; não usar remoção geral por expressão regular ou por aparência de UUID.

JSON antigo com subfluxos sem conteúdo embutido exige fornecer o pacote correspondente ou selecionar versões locais compatíveis. JSON parcial n8n/Typebot exige revisão explícita dos nós convertidos. As quatro árvores legadas da Branef continuam com suas conversões e regras documentadas; importar um arquivo não autoriza reativar chamadas HTTP antigas ao GLPI.

A publicação ocorre depois de resolver as seleções: validar o conjunto, publicar as dependências em ordem e por último a raiz. Uma falha não vincula um conjunto incompleto à caixa; versões já publicadas permanecem imutáveis e podem ser retomadas pela mesma operação. A ativação é uma etapa separada e revalida o conjunto completo. Nenhum fluxo ativo anterior muda por causa da importação.

## Estado durável e consistência

Proposta técnica: uma operação de configuração guarda progresso não secreto, revisões esperadas, intenção idempotente e pendências. Coordena os serviços existentes em vez de duplicar suas tabelas e regras. Não guardar bearer token, QR ou senha no estado do navegador. Credenciais permanecem cifradas e referenciadas pelo cofre atual.

Etapas: empresa/destino, conexão, caixa, atendentes, robô, correspondências, conferência, homologação e ativação. Estados visíveis: não iniciado, em andamento, ação necessária, resultado a conferir, pronto para testar e ativo. O plano escolhe a representação interna e migrações aditivas necessárias.

Troca de tenant limpa o assistente e aborta solicitações pendentes. Toda mutação inclui uma revisão esperada do contexto e o servidor deriva a organização da autenticação. Respostas atrasadas não avançam a configuração da nova empresa. Reconciliação após timeout lê o estado remoto antes de repetir; resultado desconhecido permanece bloqueado.

Reserva e confirmação usam transações curtas; I/O remoto ocorre fora delas. Antes de ativar, revalidar papel, tenant, identidade do transporte, vínculo, credencial, caixa, agentes, versão e dependências. Mudança concorrente impede confirmar sucesso com dados antigos. Durante a ativação a exclusividade do executor e a prioridade humana existentes continuam obrigatórias.

Cancelamento conserva recursos criados e informa como reutilizá-los; não exclui caixas, mensagens, agentes ou fluxos automaticamente. Desativação impede novas entradas sem reproduzir mensagens anteriores. Voltar à versão anterior usa o mecanismo de vínculo versionado e sua revisão, respeita as sessões fixadas e não tenta desfazer efeitos externos já confirmados.

## Experiência e diagnóstico

Reaproveitar componentes e linguagem do Broker. O assistente fica disponível a partir das conexões/integrações e pode ser retomado sem abandonar as telas avançadas. Mostrar a próxima ação concreta, com acesso ao recurso existente quando adequado; não pedir que o usuário memorize UUIDs ou copie tokens entre telas.

Mensagens de erro distinguem recurso inexistente, falta de acesso, incompatibilidade, referência da origem ainda não resolvida, conexão expirada e resultado desconhecido. Um erro não exibe credenciais nem conteúdo privado. Evidências têm escopo e data; sucesso de CI não é apresentado como entrega física.

Os detalhes de componentes, rotas e nomes internos ficam a cargo da implementação, seguindo a stack e os padrões atuais. O desenho não exige novo SDK, serviço ou provedor.

## Testes e aceite

1. Criar duas empresas sintéticas com canais, contas, caixas, agentes e credenciais distintas, incluindo colisões de números de IDs externos. Executar toda a jornada nas duas e comprovar que nenhum recurso da primeira satisfaz implicitamente a segunda.
2. Importar bot simples, pacote raiz com dependências repetidas e pacote exportado de outra empresa; validar novas identidades e correspondências. Cobrir dependência ausente, ciclo, limites, esquema desconhecido, conversões parciais e referências de destino não resolvidas.
3. Cobrir idempotência, interrupção/recarga, autorização revogada, troca de empresa, alterações concorrentes, timeout após criação remota, publicação parcial e tentativa de ativar conjunto incompleto.
4. Validar QR e Meta com adaptadores de teste independentes, além da integração com JRC/Chatwoot isolado. Cobrir entrada, resposta única, espelhamento, transferência, pausa humana e retomada explícita sem mensagens duplicadas.
5. Executar as verificações obrigatórias do repositório, revisão de código, build e gates de publicação. Conferir os artefatos e hashes efetivamente implantados.
6. Homologar fisicamente no número de teste já autorizado da Branef após recuperar a sessão da empresa. Não escrever no GLPI real nem enviar avisos/pesquisas durante esses testes. Meta física depende de um número de teste e autorização disponíveis; se ausentes, declarar essa parte pendente, mantendo a prova simulada separada.

Pronto para cada caixa significa os vínculos corretos, robô compatível publicado, transferência funcionando e evidência física da rota utilizada. Não afirmar compatibilidade universal com arquivos arbitrários ou todos os transportes a partir de uma única rota comprovada.

## Publicação e preservação das instalações

O Broker é compartilhado: publicar sua imagem altera o código disponível a todas as empresas. A exposição inicial do assistente será controlada e o piloto operacional ficará restrito à caixa de homologação da Branef. Não alterar vínculos, automações ativas, credenciais, agentes, sessões ou configurações dos demais tenants, inclusive Grupo JRC e LAB.

Migrações precisam ser aditivas e compatíveis com as telas atuais. Preservar o código já implantado, executar regressões e registrar imagens anterior/nova e procedimento de desativação do assistente. Não aplicar downgrade destrutivo nem apagar versões ou volumes. Se o JRC precisar de mudança de contrato, testar a compatibilidade e implantar somente na Branef dentro do escopo já autorizado.

O relatório de entrega apresentará o procedimento repetível, campos protegidos e sua finalidade, formatos de JSON suportados, pendências por integração, testes locais/CI/runtime/físicos separados e limitações verificadas. Não incluir chaves, senhas, tokens ou dados de conversas.

## Decisões aprovadas

Reaproveitar os serviços e o executor existentes; acrescentar coordenação durável e pacote portátil; manter publicação separada de ativação; exigir referências locais verificadas; homologar com entrada restrita e preservar configurações ativas; disponibilizar o código no Broker compartilhado com piloto restrito; declarar a comprovação Meta física pendente enquanto não existir uma rota de teste autorizada. O usuário aprovou este desenho em 09/11/2026 após a revisão técnica independente, que não encontrou dúvidas importantes em aberto.
