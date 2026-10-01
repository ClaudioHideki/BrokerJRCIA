# Broker completo antes dos módulos de central — especificação de escopo

Data: 29/09/2026. Origem: estrutura discutida e aceita pelo usuário nesta conversa, seguida do pedido de plano completo.

**Ordem mandatória:** concluir e homologar o Broker independente; depois construir os módulos Flow e QR dentro de JRC Conversas/Chatwoot. A aprovação da estrutura e deste planejamento não é autorização para implantar em produção ou excluir recursos reais.

## 1. Resultado esperado

O administrador da empresa consegue configurar uma central JRC ou Chatwoot compatível, conectar seu WhatsApp, criar ou escolher a caixa API de destino, construir um chatbot sem escrever código, testar, publicar e ativar. Cada cliente recebe atendimento isolado. O bot coleta dados, apresenta menus, consulta serviços autorizados e transfere para o time/agente escolhido; o humano assume sem concorrência do robô. Encerramento, nova conversa e retorno ao bot têm regras explícitas.

A administração JRC opera empresas, grupos, acessos, planos, suporte, saúde e ciclo de vida pelo próprio Broker. O cliente pode operar toda a jornada usando o console Broker e a central para atendimento humano, sem módulo embutido.

## 2. Limites do escopo

Incluídos na conclusão do Broker:

- Dois portais coerentes: administração JRC e workspace de empresa.
- Grupos econômicos, empresas, responsáveis, permissões, planos, limites e visão de uso.
- Cadastro/conexão/reconexão/identidade e exclusão de canais QR; canal oficial Meta conforme capacidades implementadas e homologadas.
- Central JRC gerenciada ou destino Chatwoot externo aprovado, conta, credencial, caixa API e membros.
- Catálogo da central para times/agentes/etiquetas/atributos/horários usados pelo bot.
- Construtor conversacional: texto, mídia suportada, pergunta, menu, condição, variável, horário, silêncio, consulta HTTP, IA de atendimento, transferência, nota interna, etiqueta/atributo e encerramento.
- Persistência, ordenação, deduplicação, interrupção humana, contingência, histórico e diagnóstico.
- JSON JRC versionado com esquema/exemplos para geração por IA, importação como rascunho e conversão n8n limitada.
- Suporte por chamados, intervenção administrativa auditada, exclusões persistentes e monitoramento.
- Publicação por imagens verificadas, migrations, backup/restauração, homologação e reversão de versão.

Posteriores ao marco Broker:

- Módulo de edição Flow dentro da central, usando o mesmo grafo/runtime do Broker.
- Módulo QR/onboarding/reconexão dentro da central, usando as APIs de controle do Broker.
- Migração dos motores Flow locais e conectores embutidos existentes.
- Automação pelo motor canônico de canais que entram nativamente na central, além do transporte WhatsApp administrado pelo Broker.

Fora da definição de pronto deste ciclo: clone do n8n, execução de qualquer JSON/JavaScript, marketplace genérico de conectores, discador/URA de voz, campanhas em massa novas, cobrança automática ou faturamento consolidado de grupos. Não se anuncia disponibilidade de recursos externos ainda sem credenciais/homologação. Esses itens não desaparecem de inventários históricos, mas não são dependências do chatbot solicitado.

## 3. Responsabilidades

- Broker: empresa, plano, conexão, credenciais, vínculo com caixa, fluxo, versão, sessão, execução, envio, diagnóstico, suporte administrativo.
- Central: Account, inbox, usuários humanos, times, contato/conversa e trabalho do atendente. Seus catálogos são consultados pelo Broker; não manter cópias independentes com nomes iguais e IDs divergentes.
- Provedor WhatsApp: transporte e confirmações externas. Aceite interno ou HTTP 200 não substitui recibo de entrega.
- Grupo econômico: agrupamento administrativo. Não compartilha automaticamente contas, dados, credenciais ou permissões.
- Uma empresa Broker corresponde a uma Account por instalação aprovada; N conexões podem ter N caixas. Destino é identificado pela instalação e Account, não apenas por número de Account.
- Um único executor de bot por caixa. Editor e runtime legados não devem responder em paralelo com o motor escolhido.

## 4. Jornada no Broker

1. Administração cadastra grupo/empresa e responsável, define plano/módulos/limites.
2. Proprietário/administrador da empresa escolhe JRC gerenciado ou Meu Chatwoot.
3. Destino externo passa pela aprovação já existente; credencial da Account é validada.
4. Empresa cria/conecta canal e confirma identidade.
5. Empresa cria ou adota caixa API; substituição de webhook existente tem impacto explícito.
6. Broker consulta catálogo da central e valida os destinos humanos.
7. Empresa cria chatbot por modelo ou canvas vazio, configura campos, caminhos e contingências.
8. Simula conversa sem efeitos externos; teste real usa ambiente/recurso selecionado explicitamente.
9. Publica versão imutável e ativa na caixa após diagnóstico.
10. Consulta execuções, mensagens, falhas, transferência e estado do canal.
11. Pausa novas entradas, interrompe sessões ou desativa com efeitos distintos e descritos.
12. Arquiva, desconecta ou exclui pelo procedimento específico com prévia de impacto.

A ficha da conexão deve distinguir transporte WhatsApp, integração da caixa, bot e transferência humana. Nenhum indicador mostra operação completa apenas porque existe um cadastro.

## 5. Estado e transferência

Cada sessão é isolada por empresa, canal/caixa e conversa, com versão fixada. Mensagens adicionais continuam a sessão; eventos repetidos não iniciam outra. Eventos de sistema, notas privadas e reflexos do próprio bot não disparam URA.

O motor deve reconhecer: BOT_ACTIVE, WAITING_INPUT, HANDOFF_PENDING, WAITING_HUMAN, HUMAN_ACTIVE, RESOLVED e ADMIN_PAUSED. São estados internos propostos; não são substituições literais dos status Chatwoot. A compatibilidade com os modos legados deve ser mapeada na migração.

Transferência:

- Bloquear novas respostas automáticas antes de iniciar a operação remota.
- Na transferência automática, acompanhar os efeitos anteriores com prazo; não confundir enfileiramento com envio. Assunção humana tem prioridade sobre mensagens automáticas ainda não despachadas. Incerteza do provedor fica registrada sem repetição cega.
- Garantir o mapeamento da conversa da central, mesmo se o espelhamento estiver atrasado.
- Validar destino da mesma empresa/Account/caixa.
- Atribuir time/agente e atualizar status remoto com confirmação do resultado.
- Preservar operação recuperável e apresentar falha/pendência quando a central não confirmar.
- Reavaliar controle da conversa antes de cada efeito externo.
- Volta ao bot exige ação explícita e destino definido: continuar, menu ou nova sessão.
- Após resolução, respeitar política nova/reaberta e regra de reinício. Um mapeamento remoto antigo não basta para decidir.

Não prometer entrega exatamente uma vez quando o provedor não permite confirmar um resultado desconhecido. Persistir esse estado, reconciliar e impedir repetição cega.

## 6. Editor e catálogo

Um bloco comercializado só fica disponível quando tiver formulário, contrato, validação, executor, simulação correspondente e teste de execução. Recursos ainda incompletos permanecem identificados como indisponíveis, com fluxos antigos preservados.

Menus textuais são o denominador comum. Botões/listas e formatos de mídia dependem da capacidade comprovada do canal. Horários incluem fuso; inválido/silêncio/erro têm saídas explícitas. O fluxo pode transferir para time mantendo a mesma caixa/conversa.

Canvas: arrastar, zoom ancorado no cursor, ajustar visão, localizar início/bloco, conexões visíveis, desfazer/refazer e mensagens de erro utilizáveis. Correção local de navegação é trabalho existente a concluir, não publicação comprovada.

Dados: strings, números, booleanos, null, objetos e listas com limites explícitos; nunca truncar silenciosamente resultado de consulta. O contrato inicial proposto fixa 65536 bytes por valor JSON e 262144 bytes de estado agregado, com erro de limite e teste de upgrade; são limites do motor, distintos dos de mensagem do canal. Credenciais são referências da empresa, sem segredos no grafo/exportação.

IA: uso delimitado para atendimento, com contexto autorizado, limites e transferência humana. Ações financeiras mutáveis ou ferramentas arbitrárias não são habilitadas por importar JSON.

## 7. Administração, suporte e exclusões

- Cliente abre, acompanha e responde chamado; equipe JRC recebe, assume, responde e resolve. Intervenção administrativa é registrada separadamente de ticket.
- Usuários compartilhados mantêm acessos apenas às empresas com memberships explícitos. Remover uma empresa não remove a identidade usada por outra.
- Alterar grupo ou nome não migra dados entre tenants.
- Excluir grupo vazio remove o agrupamento; grupo com empresas exige escolha explícita de realocação/desvinculação ou seleção das empresas para exclusão pelo lifecycle. Não há cascata invisível.
- Excluir empresa/canal usa prévia, confirmação nominativa, operação persistente, tratamento de trabalhos em andamento e limpeza externa rastreável.
- Exclusão no Broker não apaga automaticamente Account, Inbox, histórico remoto ou WABA. A prévia mostra esse limite. Uma exclusão remota futura exige operação própria e escopo verificável.
- Grupos não significam cobrança consolidada. Custos medidos/estimados e faturamento real são identificados como tais.
- Anexos e notificações externas de suporte são incrementos posteriores; a fila e o histórico internos precisam ser completos no marco atual.

## 8. Segurança, operação e compatibilidade

Reutilizar isolamento, RLS, idempotência, roles dedicadas, vault e proteção de rede existentes. Cada nova alteração deve verificar papel atual e empresa/caixa. QR e Flow terão credenciais separadas quando houver delegação futura.

Versionar contrato, dado persistido e vínculo. Migrações aditivas e testes de upgrade devem preservar versões publicadas/sessões em curso. O retorno a imagem antiga depende da compatibilidade do schema; não aplicar reversão destrutiva do banco como rotina.

Cada instalação Chatwoot/fork deve passar por teste de capacidade: autenticação, caixa API, assinatura do callback, mensagens, mídia e ações de atendimento. Não presumir suporte por número de versão ou presença de um menu.

Métricas por empresa/conversa: atraso de entrada/saída, backlog, resultado desconhecido, bot/time/humano, falha de transferência, heartbeat e uso. Logs sem credenciais e com contexto mínimo necessário.

## 9. Marco obrigatório: BROKER_READY

Somente considerar pronto quando:

- Cliente configura e opera pelo Broker sem instalar módulos dentro da central.
- Uma jornada completa é comprovada com JRC e outra com uma instalação externa homologada.
- Dois clientes e duas empresas não compartilham estado/dados.
- Bot nativo funciona de ponta a ponta, inclusive handoff, silêncio, falha, interrupção humana, retomada e nova mensagem após resolução.
- JSON nativo faz round-trip; importação parcial não é anunciada como execução completa do n8n.
- Administração, suporte, lifecycle e limites passam em testes de integração/E2E.
- Build/CI, migrations de banco vazio e upgrade, imagem, restauração e rollback de aplicação são verificados.
- Relatório relaciona commit, digests, configuração não secreta, escopo anunciado, limitações e evidências.

QR e Meta têm aceite separado. Falta de App/WABA/credencial é pendência externa do aceite Meta; não pode ser escondida com teste simulado. Uma release limitada a QR pode ser publicada como tal, mas não encerra o item oficial do plano.

Nenhum status de containers, botão, teste unitário isolado ou importação aceita substitui esse marco.

O marco é comprovado em ambiente de homologação autorizado, com candidato à release identificado. A promoção em produção usa tarefa e validação próprias; não é exigência implícita deste planejamento.

## 10. Etapa posterior: módulos QR e Flow

Depois de BROKER_READY:

- Flow delegado compartilha definição, versões, catálogo, teste, publicação e vínculo do Broker. Não cria outro runtime.
- QR delegado usa contexto de Account/Inbox, sessão curta, permissões por usuário, reconciliação e revogação.
- JRC nativo pode receber menus próprios; Chatwoot padrão pode usar Dashboard App dentro da conversa e console externo. Um assistente nativo em Configurações exige extensão/fork instalado e homologado.
- Reutilizar código/contratos existentes após revisão; não ativar as branches antigas indiscriminadamente.
- Testar atualização, desinstalação, revogação e troca do executor sem apagar histórico.

## 11. Evidências e documentos de origem

- [Diagnóstico de caixas e atendimento](../../integrations/2026-09-29-chatbots-inboxes-routing.md).
- [Implementação existente de produto](../../implementation/broker-product-20260929.md).
- [Desenho prévio de delegação A1/A2](../../integrations/jrc-flow-delegation-a1-a2-20260925.md).
- [Plano anterior de low-code](../plans/2026-09-29-lowcode-funcional.md), agora subordinado à ordem Broker primeiro.

Base inspecionada: Broker 9466f6a, com alterações locais de canvas ainda não publicadas; JRC local 239c8358, diferente do build capturado. A primeira tarefa de execução reconcilia a base com a main atual antes de aplicar mudanças.
