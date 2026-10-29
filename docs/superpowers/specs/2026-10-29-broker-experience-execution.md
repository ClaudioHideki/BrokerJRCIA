# PROMPT DE EXECUÇÃO — BROKER JRC, EXPERIÊNCIA DE USO E INTEGRAÇÕES

Data de preparação: 29/10/2026. Idioma do produto e da documentação: português do Brasil.

## 1. Missão e forma de executar

Atue como responsável técnico pela evolução do Broker JRC e por seus contratos com JRC Conversas e parceiros como CCLX. Entregue implementação funcional, telas acessíveis por perfil, configurações compreensíveis, contratos documentados, testes executados e evidências de homologação. Execute o trabalho por fases verificáveis; não encerre após produzir um plano ou um protótipo de interface.

Repositórios de referência:

- Broker: https://github.com/ClaudioHideki/BrokerJRCIA
- JRC Conversas: https://github.com/ClaudioHideki/jrc-conversas-lab2

Correção expressa do usuário em 29/10/2026: `jrc-conversas-lab2` é a origem utilizada. A referência anterior a `jrc-conversas-nico-v12-2-7-comercial-integrado` serviu apenas à comparação histórica e não é o alvo desta execução. Consultar a baseline de origem atual em `docs/validation/2026-10-29-jrc-source-baseline.md`.

Comece lendo README, AGENTS.md, arquitetura, contratos, migrations, scripts, CI e instruções do ambiente. Descubra branches, PRs, commits e trabalho local em andamento. Preserve alterações alheias e use branch/worktree isolada quando necessário. Mantenha o stack, design system e padrões existentes; crie componentes ou serviços novos somente quando houver uma responsabilidade que os justifique.

A análise de 27/10 usou Broker PR4/head `16a2a371e44de65a901cf1a9405bf4939ee1f213`, com main `be1e9441146d3ce8f9bc29b2f1b2fd135daf4371`. Foram inventariadas 347 operações em 305 paths, um perfil público de 34 operações e 96 cenários iniciais. São referências históricas, não metas fixas de contagem. O JRC foi analisado principalmente em `c6a877effa260ee752a81eaf8d52e81be1d22f2e`/`6d5b526d3ea67fd5a3ecc339b5912d4218ff02f3`; documentos posteriores também mencionam `ab997ac5335992020181217a2dc66efffdbfd27c` e publicação `202c84cc`. Reconcilie as revisões atuais antes de alterar. Não retroceda o produto nem refaça uma entrega já existente.

Está no escopo implementar e testar mudanças reversíveis no ambiente de desenvolvimento/homologação, preparar commits e PRs e produzir a release revisável. Respeite as permissões do ambiente. Antes de alteração destrutiva, migração de produção, troca de credencial/engine de cliente, deploy produtivo ou envio/chamada para destinatário real fora do laboratório autorizado, apresente o resultado concreto, impactos e retorno para aprovação. Não peça confirmação repetida para tarefas já autorizadas. Não exponha segredos nem faça testes destrutivos em produção.

Se faltar acesso ao servidor, à instalação CCLX ou a um ativo Meta, registre precisamente a dependência, prepare o teste/roteiro e continue as frentes independentes. Não simule aprovação externa nem declare 100% funcional sem evidência. Resolva decisões rotineiras com os padrões do projeto; faça perguntas apenas quando a resposta ausente realmente mudar o contrato ou impedir a execução segura.

## 2. Decisão de produto: API JRC comum e dois modos de integração

O CCLX usa Chatwoot como base, mas sua versão e suas customizações precisam ser verificadas. A decisão já tomada é CCLX consumir a API JRC pelo próprio backend, usando organização e credencial exclusivas. JRC Conversas também deve aproveitar a mesma base de capacidades Broker. Preservar a integração direta Chatwoot existente como opção; não migrar conexões atuais silenciosamente.

**Modo A — API de parceiro:**

- JRC fornece base URL, credenciais com escopos, documentação, contrato de mensagens/eventos e mecanismos de reconciliação.
- Backend do parceiro guarda a chave, identifica usuário/tenant local, chama o Broker e projeta mensagens/status na própria aplicação.
- Criar tenant, chave e acesso à documentação não exige URL, Account ID nem token administrativo do Chatwoot do parceiro.
- Recebimento por webhook exige cadastrar um destino de callback autorizado. Oferecer polling/cursor previsto pelo contrato quando aplicável; não prometer entrega ao host sem nenhum consumidor.
- QR e Flow dentro do host usam BFF e permissões reais do host. A chave de serviço não pode ficar em bundle, localStorage, URL ou código do widget.

**Modo B — integração direta Chatwoot/JRC:**

- Broker utiliza destino aprovado, origem HTTPS, conta, credencial remota e vínculos explícitos de inbox.
- Reutilizar onboarding, adoção, controle, assinaturas, revisões, grants e reconciliação já implementados.
- A UI explica quando esses dados remotos são necessários e qual lado cria a caixa.

Escolher um proprietário de envio e um de projeção de mensagens por conexão/caixa. Não ativar os dois caminhos simultaneamente na mesma caixa sem controle explícito contra duplicação. Paridade funcional entre os modos deve ser demonstrada por capacidade e teste. A proposta histórica CCLX inicial era de WhatsApp oficial; a ampliação do produto Broker não altera automaticamente o compromisso comercial daquele piloto.

## 3. Descoberta inicial e entregáveis de engenharia

Antes da primeira alteração, faça diagnóstico suficiente da baseline e do primeiro lote de trabalho. Inicie os artefatos abaixo e mantenha-os no repositório, nas convenções locais, ampliando-os durante as entregas. Não refaça uma auditoria integral de centenas de rotas antes de começar uma melhoria já compreendida:

- Diagnóstico atual com SHAs, árvore de módulos, rotas, telas, flags e fontes.
- Mapa de navegação existente → navegação proposta, incluindo URLs legadas.
- Matriz de papéis, ações, scopes, grants e capacidade por provider/versão.
- Contratos dos dois modos de integração e responsabilidades de Broker/host.
- Plano por entregas pequenas, com arquivos reais afetados, interfaces, testes e aceite.
- Registro de progresso com concluído, evidência, pendência, próximo passo e bloqueio externo.

Reutilize o plano e a matriz de 27/10 se estiverem anexados; sem eles, regenere o inventário a partir do código. Compare documentação com implementação. Arquivos antigos que dizem “não implementado” não prevalecem sobre código e testes posteriores.

Pontos de entrada já identificados no Broker, a confirmar no checkout escolhido:

- Router/sidebar/ícones: `apps/web/src/app/App.tsx`, `layout/AppShell.tsx`, `layout/PlatformShell.tsx`, `broker/Icon.tsx` e `auth/guards.tsx`.
- Empresa/chaves/canais: `apps/web/src/pages/Company.tsx`, `ApiKeys.tsx`, `Channels.tsx`, `ChannelDetail.tsx` e `MetaConnect.tsx`.
- Integração: `apps/web/src/integrations/ChatwootPanel.tsx`, `ChatwootControlPanel.tsx`, `NativeJrcSetup.tsx` e `ChatwootDestinationPanel.tsx`.
- Flows: `apps/web/src/pages/AutomationStudio.tsx`, `flows/FlowCanvas.tsx` e `native-flow/`; `/flows` já possui redirecionamento para `/automations` na base auditada.
- Portal: `scripts/docs/assets/`, `build-portal.mjs`, `public-api.mjs` e `docs/api/openapi.json`; parceiro: `integrations/partner-qr/` e `docs/api/partner-onboarding.md`.
- Grupos/histórico: `apps/web/src/pages/WhatsAppGroups.tsx`, `WhatsAppGroupAutomation.tsx`, `WhatsAppGroupEventsConfiguration.tsx` e `channels/HistoryImportPanel.tsx`.

A cada entrega: reproduza o defeito ou fixe o aceite, implemente a mudança, execute os testes relevantes, revise diff/contrato, registre evidência e avance. Use agentes em frentes independentes quando disponíveis, com propriedade clara de arquivos e revisão integrada. Não exija dezenas de aprovações de microtarefas. Em limite de sessão, salve checkpoint e instrução exata de retomada; não marque o projeto completo.

## 4. Navegação, módulos e experiência de uso

O objetivo é que administrador e operador encontrem conexão, integração, caixa, documentação, mídia, Flow e diagnóstico sem conhecer nomes internos da arquitetura. Reaproveite a navegação e os ícones já existentes; corrija descoberta, organização, permissões e jornadas.

Crie um registro único de navegação com item, rota, seção, ícone, permissão/capacidade e disponibilidade. Use os componentes/ícones do design system atual. Sidebar com ícone E rótulo, estado selecionado, agrupamentos, recolhimento, versão mobile e navegação por teclado. Não usar ícone isolado como único meio de descobrir uma função.

Estrutura-alvo, adaptada às rotas reais sem duplicar telas:

- **Visão geral:** saúde operacional e ações pendentes clicáveis.
- **Conexões:** WhatsApp QR/Evolution, WhatsApp oficial/Meta, identidade e estado de cada conexão.
- **Caixas de entrada:** criar/selecionar, vincular conexão, host, agentes e automação.
- **Integrações:** JRC Conversas, Chatwoot externo e API de parceiro/CCLX, com modo explícito.
- **Mensagens e eventos:** consultas, recibos, erros e correlação, limitados às permissões.
- **Flows:** editor, versões, publicação, instalações, execuções e handoff.
- **Campanhas:** canais elegíveis, aprovação, execução e resultados.
- **Mídia e armazenamento:** arquivos autorizados, uso, quota e configuração permitida.
- **Chamadas:** capacidades habilitadas, operação e histórico autorizados.
- **API e webhooks:** guia rápido, documentação, chaves, assinatura, eventos e testes.
- **Monitoramento:** filas, atrasos, falhas, conexão, entrega e diagnóstico por recurso.
- **Configurações:** usuários/papéis, preferências, segurança e parâmetros da empresa.

Console de plataforma separado: empresas, usuários globais, providers/engines, limites, configuração global, infraestrutura e auditoria. Deixar sempre visível o contexto atual: plataforma ou empresa selecionada. Não transportar autoridade global para o contexto de cliente sem concessão explícita, temporária e auditada.

Implementar breadcrumbs, busca de páginas/configurações, links contextuais e retorno à lista preservando filtros. Funções principais devem ser alcançadas em até dois cliques a partir da seção correspondente. Preservar deep links e redirecionamentos de rotas antigas. Listas devem ter busca, filtros úteis, paginação, estado vazio com próximo passo e ações permitidas.

Criar um centro de configurações que direcione para cada configuração real. Classificar origem/escopo: plataforma, empresa, conexão, integração, inbox e deployment. Mostrar valor efetivo quando permitido, segredo mascarado, validação, impacto e necessidade de reinício quando real. Não oferecer um botão “salvar” que apenas altera o frontend nem fingir que um parâmetro de ambiente já foi aplicado ao runtime.

Corrigir especificamente os rótulos e destinos auditados: `/minha-empresa` aparece como “Configurações”, mas contém principalmente limites/atalhos; “Eventos” do canal pode abrir histórico de operações. Distinguir eventos de conexão/operação, mensagens recebidas, entregas de webhook e grupos. Preservar nomes e rotas legadas por compatibilidade, conduzindo o usuário à área correta. Não apresentar o diagnóstico atual por regras do JRC Brain como IA generativa sem implementação própria.

Cada tela precisa de loading, sucesso, erro acionável, falta de permissão, configuração pendente e capacidade não suportada. Bloquear ação por motivo concreto, com orientação útil. Não apresentar botão funcional para rota inexistente. Separar “código implementado”, “configurado” e “homologado” nos diagnósticos administrativos.

## 5. Papéis e isolamento multiempresa

Mapeie os papéis abaixo às roles atuais; não renomeie contratos de autenticação desnecessariamente:

- Administrador da plataforma JRC: gestão global e suporte auditado.
- Administrador da empresa: somente recursos e usuários da própria empresa.
- Operador/agente: caixas atribuídas, operações concedidas e informações necessárias ao atendimento.
- Desenvolvedor/integrador: documentação e credenciais técnicas autorizadas, sem privilégio global implícito.

Na base auditada há `SUPER_ADMIN/SUPPORT` na plataforma e `OWNER/ADMIN/OPERATOR/VIEWER` no tenant. Preservar suas diferenças, sessões e CSRF; a persona integrador pode ser atendida por capacidades existentes, sem criar uma role paralela por conveniência.

Todo acesso deve ser validado no backend. Esconder menu não substitui autorização. Pareamento delegado exige membership atual, grant e condições de identidade previstas no contrato. “Supervisor” não equivale automaticamente a administrador. Revogação durante uma requisição deve impedir devolver QR, mídia ou resposta sensível.

Preservar separação entre Account do Chatwoot, Organization Broker e organização comercial do CRM. Respeitar constraints e RLS onde existentes; não presumir RLS no Rails sem verificar. Distinguir origem da instalação, account_id, inbox_id, integration_id, canal/instância, conversation display_id e ID de banco. source_id não é global.

Na troca de empresa/caixa, cancelar requests/polling antigos, limpar caches de contexto e impedir resposta tardia de aparecer no tenant novo. Testar também múltiplas abas, browser back, revogação e usuário membro de várias empresas.

## 6. Conexões, assistentes e caixas de entrada

Entregar jornada guiada: escolher empresa → provider → modo de integração → criar/selecionar conexão → parear/cadastrar Meta → criar/selecionar caixa → atribuir agentes → definir automação → testar jornada → mostrar pendências reais.

Explicar por etapa o que será criado e permitir recuperação de falha parcial. Não apagar caixa, conversa ou sessão existente para contornar erro. Repetir onboarding não cria recursos duplicados. Adopt reutiliza o vínculo conforme o contrato existente; não inventar exigência de Idempotency-Key onde o controller não a possui.

No modo parceiro, criar instância Broker não cria automaticamente inbox CCLX: implementar essa operação no adapter/BFF do host e persistir o binding. No modo direto, reutilizar o provisionamento/adoção remoto existente.

Exibir estados separados: instância criada, sessão WhatsApp, identidade, credencial, callback, worker/entrega e caixa apta ao atendimento. QR exibido ou HTTP 202 não significam atendimento operacional. Pareamento é POST de intenção seguido de consulta; reload deve reconciliar a operação sem repetir POST automaticamente. Nunca persistir QR ativo em armazenamento inseguro.

## 7. Evolution: contrato da versão real e eventos

Identifique versão, imagem, configuração efetiva e adapter Evolution em uso. Evolution 2.3.7 é referência histórica, não autorização para upgrade automático. Compare documentação oficial com schema/código da versão instalada antes de montar payloads; nomes e formatos de webhook podem divergir entre versões.

Homologue lifecycle, QR/pareamento, conexão, reconexão, desconexão, identidade e session ownership. Não exponha API key administrativa Evolution ao cliente. Não redirecione uma sessão para outra empresa nem permita dois proprietários ativos da mesma sessão.

Crie catálogo de eventos suportados na versão real: sessão/QR, entrada e atualização de mensagem, ACK/status, contatos/chats, grupos/participantes, histórico, presença e eventos de chamada quando existentes. Para cada evento registre: nome exato, schema/amostra sanitizada, inscrição/configuração, handler, versão normalizada, escopo tenant/canal, persistência, destino, teste e tratamento de erro.

Assinar/validar a entrada conforme os mecanismos realmente suportados e a política do Broker. Processar webhook com idempotência, persistência durável antes do ACK pertinente, limites de tamanho e backpressure. Evitar segredo em URL/log. Não ligar “todos os eventos” cegamente: habilitar o conjunto suportado e necessário, com política para eventos volumosos e desconhecidos.

Conferir por leitura o resultado salvo da configuração, incluindo URL/headers, byEvents/base64 e catálogo. O código 2.3.7 usa objeto webhook aninhado e events vazio pode expandir para todos; não reutilizar payload de outra documentação/engine. Ajustar o receiver ao sufixo de URL de byEvents quando habilitado. Processar todos os elementos de arrays/batches de eventos, não só o primeiro. Detectar duplicação entre webhook global/local e entre ponte nativa Evolution→Chatwoot e ponte Broker→host.

Receber e encaminhar com semântica preservada: texto, imagem, documento, vídeo, áudio/PTT, reply, edições, exclusões e reações onde suportados. Eventos importados de histórico não devem disparar automação como mensagens novas. Documentar ausência de capacidade, sem fabricar um evento equivalente.

## 8. Meta oficial: configuração, ativos e identidade

Separar configuração global do App Meta, conexão/ativos de cada empresa e operação diária. Proporcionar painel com configuração necessária, ativos vinculados, permissões, inscrição de webhook, token/expiração, templates e diagnóstico, limitado ao perfil autorizado.

Consultar documentação oficial atual e fixar a versão Graph/API homologada. Validar Embedded Signup/fluxo manual suportado, state/nonce, callback, code único, cancelamento, repetição, WABA, phone_number_id, propriedade dos ativos, permissões e register/refresh/revoke. sessionInfoVersion do frontend não comprova a versão/configuração do Embedded Signup.

Confirmar challenge, assinatura do corpo bruto quando prevista, dedupe, roteamento da WABA/número para o tenant correto e eventos de mensagem/status/qualidade/ativos/templates que o produto utiliza. Impedir vínculo de ativo de outra empresa.

Implementar identidade tipada para telefone, BSUID e demais identificadores previstos pelo provider. Não exigir telefone artificial para um contato BSUID-only nem confundir identidade do cliente com metadata.phone_number_id do número empresarial. Preservar ID/payload de botão/lista, contato, localização e conteúdo estruturado. Testar opções com título igual e IDs distintos.

Templates, janela de atendimento, quotas e restrições do perfil devem resultar em validação e diagnóstico acionáveis. O teste de integração deve provar ida e volta reais em ativo autorizado; mock de webhook não é homologação da conta Meta.

## 9. Grupos e matriz de capacidades

Grupos fazem parte do escopo de produto onde a engine e a conta oferecem suporte. Não declarar que Meta nunca suporta grupos nem assumir paridade com Evolution. Conferir Groups API, elegibilidade, operações e limites oficiais na data da implementação e no ativo real.

Construir matriz por provider, versão e perfil: mensagens individuais, grupos, texto/mídia, interativos, reações/edição/exclusão, histórico, eventos, chamadas e gerenciamento. Estados: suportado/homologado, configuração necessária, sem permissão, implementação pendente, não suportado e dependência externa. UI, documentação e backend devem concordar.

Nos grupos distinguir chat/grupo, autor/participante, destinatário, telefone/JID/LID e identidade empresarial. Usar chaves compostas; não converter ID de grupo em número de contato. Testar participantes, mudanças de grupo, reply/menções e política de automação onde suportados. Validar como o host representa grupo/conversa; não afirmar que uma inbox API padrão já oferece toda a experiência de grupo.

Na Evolution/Baileys, conferir `groupsIgnore=false` para os grupos autorizados. Se a ponte nativa Chatwoot for o caminho escolhido, revisar `ignoreJids`: `@g.us` ou o JID específico pode bloquear esses eventos. Isso não autoriza ativar uma segunda ponte. Usar nomes da versão real: a referência 2.3.7 possui `GROUPS_UPSERT`, `GROUP_UPDATE` e `GROUP_PARTICIPANTS_UPDATE`. Catálogo, mensagem de grupo e atualização de participantes são aceites separados.

Eventos desconhecidos devem ter tratamento limitado, observável e sanitizado, sem perda silenciosa de eventos críticos nem crescimento ilimitado de payloads. “Todos os eventos” significa cobertura enumerada do contrato homologado, não um checkbox que supõe capacidades futuras.

## 10. Mensagens, mídias, áudio e S3

Implementar e testar cada direção: WhatsApp → Broker → inbox JRC/host e operador/Flow/campanha → Broker → provider → recibo. Preservar IDs, dedupe, reply e tipo de mensagem. Notas privadas, ecos, histórico e atualização de status não podem virar novos envios. Separar aceitação, envio confirmado, entrega e leitura.

Corrigir a política de transições no caminho Rails quando ainda necessário: a auditoria histórica encontrou bloqueio apenas de read→delivered no serviço geral. Testar read/delivered→sent/failed por evento antigo e retry legítimo failed→sent. Proteção específica do webhook não é garantia de todos os callers. Timeout após possível aceitação gera estado incerto e reconciliação, não retry cego.

Completar upload/download/envio pela API de parceiro conforme os mesmos controles da console: autorização, limites, quota, arquivo durável, referência de mídia, despacho e recibo. Adapter interno capaz de mídia não prova endpoint público autorizado.

Preservar o backend de mídia atual e acrescentar/completar S3 compatível quando aplicável. Não tornar MinIO obrigatório nem confundir “usar S3” com migrar arquivos existentes. Expor configuração no escopo permitido: endpoint, região, bucket, modo de acesso, retenção, quota e teste de conexão; credenciais ficam no servidor. Identificar parâmetros que exigem deployment/reinício.

Definir a relação entre mídia Broker e Active Storage do JRC: quem guarda o objeto, quem autoriza, se o host copia ou referencia, prazo de acesso e política de eliminação. Compartilhar endpoint/bucket não significa compartilhar tabelas, chaves ou autorização. Mudança de storage exige plano de cópia, integridade, referências e retorno.

Cobrir MIME real/tamanho, limites, timeout, extensão, filename seguro, integridade, upload incompleto, URL expirada, download provider expirável, redirects e SSRF. Nunca disponibilizar bucket público como correção de permissão. Usar URLs curtas/autorizadas ou proxy privado conforme contrato, com política explícita de expiração e revogação. Não persistir chaves S3 no browser nem base64 ilimitado em logs/eventos.

Testar imagem, documento, vídeo, áudio e PTT, codecs compatíveis, reprodução no host, nome/legenda e arquivos grandes dentro dos limites. Distinguir áudio como arquivo, transcrição e chamada ao vivo. Backup/restore deve cobrir banco, objetos e chaves de cifra.

## 11. Flows completos e integração com o atendimento

Reutilizar editor, motor, versões, sandbox e delegação existentes. Descobrir as rotas atuais, inclusive `/v1/delegated-flows` quando presentes, antes de implementar outra superfície.

Entregar ciclo completo: criar rascunho → editar → validar → simular → publicar versão → instalar/associar à inbox/conexão → executar → acompanhar → pausar → retomar/rollback. Um grafo salvo sem executor e instalação não é Flow funcional.

Mapear e completar os nós necessários: gatilhos de mensagem/webhook/agendamento previstos; variáveis tipadas; condições; espera/resposta; texto/mídia; ações interativas por capacidade; requisição HTTP autorizada; subfluxos com limite; tratamento de erro/timeout; IA quando habilitada; handoff e encerramento. UI, contrato e executor devem ter paridade. Impedir publicação com nó sem runtime, credencial inválida, caminho impossível ou capability indisponível.

Persistir execução, espera, versão e checkpoints. Aplicar limites de tempo, passos, recursão, concorrência e custo. Revalidar tenant, credencial, owner/revisão e estado da conversa antes de cada efeito externo. Sandbox e HTTP precisam impedir acesso a segredos/host/destinos proibidos. Recuperação após restart não repete efeito confirmado.

Eleger um executor automático por conversa/caixa entre Flow JRC, Broker, NICO e outros bots. Mensagem humana/handoff deve invalidar respostas automáticas pendentes. Retomada explícita no ponto permitido; reconexão não reinicia o diálogo por acidente. Comprovar atribuição e recibo do handoff no host.

No módulo embarcado do host, usar sessão/grant de Flow específico, curto e revogável. Chave de QR/texto não vira credencial universal do editor. Migração JRC/n8n→Broker deve preservar semântica ou apresentar incompatibilidades por nó, bloqueando publicação insegura.

Para IA, preservar o provider/modelo homologado até benchmark; usar OpenAI conforme decisões JRC. Isolar contexto, ferramentas, RAG e budgets por empresa. Revalidar a restrição histórica do runtime NICO provider de uma conta por deployment e implementar roteamento/provisionamento ou refatoração comprovada. Conteúdo externo não pode alterar autorização de ferramentas.

## 12. Campanhas e chamadas

Campanhas: preservar consentimento, blacklist, aprovação, janela/template, quotas, pausa/cancelamento e UNKNOWN. Verificar se o dispatcher Rails ainda exige `Channel::Whatsapp` e adaptar a inbox `Channel::Api` ao contrato canônico Broker.

Fluxo de campanha: mensagem canônica com atributos → reserva campaign-intents → associar intentId → callback assinado → fila existente e revalidação → despacho → recibo por recipient. Reserva não envia a mensagem. Tratar callback prematuro, reserva expirada, falha entre etapas e revogação. Um único componente realiza o envio físico.

A mensagem canônica deve permanecer não despachável até a reserva e o intentId estarem associados de forma durável. Verifique callbacks after_create do Rails e implemente preparação/outbox ou controle equivalente para publicar somente o evento autorizado, recuperando falha entre etapas. Não contorne o contrato usando uma nota privada como mensagem de campanha nem deixe uma corrida decidir se o envio acontece.

Chamadas: implementar uma entrega própria, distinguindo áudio anexado, WhatsApp não oficial, Meta Calling e SIP/PABX. Não equiparar evento CALL a áudio no navegador. Verificar a capacidade do engine atual; se exigir engine/adapter adicional, documentar decisão, licença, sessão, codecs, infraestrutura e isolamento, mantendo a mensageria existente.

O contrato de voz inclui empresa/inbox/sessão, callId, operador, iniciar/receber/atender/rejeitar/encerrar, ocupado, expiração, eventos e reconciliação. Toda operação e negociação de mídia verifica ownership server-side. Implementar widget/BFF sem chave administrativa no browser, HTTPS, microfone, SDP/ICE e caminhos de mídia previstos. Gravação/transcrição exigem autorização, retenção e vínculo de conta/usuário/ramal e conversa quando houver.

Provar áudio bidirecional em redes distintas, codec real, recusa, queda, concorrência e isolamento. Não reaproveitar sessão Evolution em outra biblioteca sem homologação. Calling oficial deve seguir documentação, elegibilidade e permissões reais. Se uma dependência externa impedir áudio real, concluir contrato/implementação/testes locais possíveis e registrar o bloqueio; não apresentar mock ou feature flag como entrega final de voz.

## 13. Portal API e pacote de integração CCLX/JRC

Dentro do painel, entregar uma área API e webhooks descoberta pela sidebar, para o perfil autorizado. Incluir base URL real por ambiente, guia rápido, credencial/scopes, expiração/rotação/revogação, IDs e exemplos com placeholders, limites, erros, idempotência, mídia, cursor, eventos, assinatura, retry e reconciliação.

Gerar documentação a partir do contrato atual. Publicar o perfil público correto, separado das rotas internas/plataforma; provar que `/documentation/` ou a rota adotada abre o portal e não o fallback da SPA. Não alterar silenciosamente bind/porta da API ou proxy apenas para expor Swagger. Testar asset paths, proxy, CSP e autenticação conforme arquitetura.

Preservar as proteções do portal já existente: credencial somente em memória, origem/rotas permitidas, uma credencial por request, ausência de cookies no cliente público e escrita opt-in. O perfil auditado de parceiro ainda não cobre envio de mídia, grupos, templates Meta ou gestão de Flows. Ampliar contrato e autorização expressamente, com testes de compatibilidade; não basta incluir endpoints JWT/admin na allowlist pública.

Oferecer OpenAPI e coleção Postman sincronizados e um roteiro de teste ponta a ponta. Playground não embute chave administrativa, não guarda segredo em URL/log e não envia mensagens/chamadas automaticamente. Usar contexto autorizado e alvos de teste; operações de efeito real precisam de ação deliberada do usuário.

Eventos de parceiro: segredo de assinatura separado, timestamp/eventId/corpo conforme contrato existente, retry com backoff, dedupe, fila durável, entregas/falhas visíveis, replay e cursor/retention definidos. Documentar se e como revogação de chave afeta subscription; não presumir cancelamento automático. Pub/Sub só deve ser configurado quando houver contrato/transporte confirmado, sem inventar infraestrutura CCLX.

Entregar adapter/pacote com guia, configuração server-side, BFF, persistência de bindings, inbox/outbox do host, tratamento de mensagens/status/mídia e módulos QR/Flow quando compatíveis. `integrations/partner-qr` é referência Node; não é instalador Rails completo. Não substituir autenticação/CSRF/membership por hooks fictícios ou true fixo.

Testar instalação limpa e atualização no JRC e na versão Chatwoot alvo selecionada. Sem acesso à instalação CCLX, entregar o pacote e o protocolo de homologação externa, identificando exatamente a versão e os casos ainda não validados. CCLX e JRC devem usar organizações/credenciais próprias.

## 14. Infraestrutura e observabilidade

Conferir imagem/digest, schema, flags, TLS, DNS, relógio, portas, recursos, storage e todos os consumidores das filas habilitadas. partner-events-worker historicamente depende do profile partner-api; verificar serviço real e progresso, não apenas presença no YAML. Heartbeat somente onde existir instrumentação.

Broker usa Postgres para estado e filas duráveis e Redis em funções específicas; Rails/Sidekiq têm seu próprio contrato. Não substituir a arquitetura por outra fila sem necessidade comprovada. Separar runtime/migrator e preservar controles de isolamento.

Correlacionar request, tenant, conexão, inbox, mensagem, job, evento, campanha, Flow e chamada conforme o fluxo. Expor diagnósticos sanitizados: idade da fila, atrasos, erros, retries, disponibilidade, quota e uso de storage. Indicador deve abrir a lista/registro e ação autorizada correspondente. Mensagem “conectado” não deve esconder fila parada ou callback inválido.

Medir carga por perfil, p50/p95/p99, backpressure e competição entre empresas. As metas históricas CCLX de 300 lojas/80 mil mensagens por dia e expansão a 900/250 mil são requisitos a dimensionar e testar, não capacidade comprovada nem autorização para gerar tráfego pago real.

Testar backup/restore de banco, objetos, configuração e chaves. Medir RPO/RTO. Revalidar compatibilidade de schema e retorno; o rollback 0073→0072 não foi homologado na auditoria histórica. Se não houver acesso remoto, preparar coleta de leitura com saída sanitizada, sem dump de ENV, tokens ou dados de clientes.

## 15. Testes obrigatórios e critérios de qualidade

Criar rastreabilidade requisito → tela → endpoint → regra → teste → evidência. Usar testes para riscos reais; não inflar contagem com assertions que apenas espelham implementação. Reutilizar as suites e o harness conjunto existentes, atualizando as revisões.

Cobrir:

- **Unitários:** schemas, normalização, estados, autorização, validators de Flow e políticas de UI.
- **Integração:** Postgres/roles/RLS Broker, constraints Rails, jobs/leases, Redis/Sidekiq, storage e adapters.
- **HTTP/contrato:** cada operação e perfil, sucesso, credenciais ausentes/incorretas, papel/scope, IDs de outro tenant, payload/limites, replay e recuperação aplicáveis.
- **Frontend/browser:** sidebar por perfil, deep link, busca, forms, erros, QR, troca de conta, anexos, Flow, portal API, mobile e acessibilidade.
- **Dois sistemas reais em laboratório:** onboarding, inbox, BFF, HMAC, mensagens, status, notas privadas, handoff e campanhas.
- **Providers reais autorizados:** ida/volta de texto/mídia, grupos/eventos e chamadas efetivamente suportados.
- **Falhas:** timeout antes/depois do ACK, duplicata concorrente, evento fora de ordem, revogação em voo, restart, provider lento, store indisponível, replay/cursor expirado e restauração.

Os testes de isolamento incluem duas empresas, caixas diferentes, usuário multiconta e colisões de identificadores. A política de autorização deve continuar válida na consulta de bytes/mídia e na negociação de chamada, não só na listagem de metadados.

No Broker, conferir e executar os scripts atuais de build, typecheck, unidade, web, partner QR, integração, compiled, e2e, storage, container, restore, geração OpenAPI e editor nativo conforme pré-requisitos da CI. ci:verify não deve ser tomado como sinônimo de todo o workflow. Banco de teste deve ser explícito: db:migrate:test historicamente pode cair em DATABASE_URL. Não executar isso em produção por causa do nome “test”.

No JRC, executar suites Rails/Vue/browser e o harness com o par de SHAs escolhido. Acrescentar restart real: o harness histórico adianta ActiveJob e não valida Sidekiq/Redis após reinício. Newman/harness com serviços sintéticos não equivale a provider real nem a integração instalada.

Registrar comandos, revisão/digest, ambiente, pré-condições, resultado e artefato sanitizado. Distinguir aprovado, falhou, não executado, bloqueado e não aplicável justificado. Build/publicação verde não comprova aceites funcionais.

## 16. Ordem de implementação e conclusão

Execute nesta ordem, paralelizando apenas frentes sem dependência:

0. Reconciliar fonte/instalação e mapear requisitos, rotas, navegação e capacidades.
1. Estruturar permissões, navegação e configurações, reaproveitando páginas existentes e seus backends.
2. Fechar lifecycle de conexão, onboarding Meta/QR, integração e criação/vínculo de inbox.
3. Completar API de parceiro, eventos, mídia/S3 e status, com contrato conjunto.
4. Completar Flows, delegação, handoff e campanhas, com autoridade única.
5. Entregar grupos/capacidades por provider, IA habilitada e chamadas com seus gates específicos.
6. Concluir portal API, pacote de integração e documentação; antecipar partes independentes durante as fases anteriores.
7. Executar regressão, carga controlada, restauração, revisão independente e release candidata.

Atualização Chatwoot/Evolution deve ter análise de compatibilidade e branch própria quando necessária ao escopo. Verificar release oficial atual, customizações e migrations; não usar latest como identidade da release nem substituir engine automaticamente. Preservar módulos JRC e números ativos.

**Definição de pronto por módulo:** UI utilizável + backend/persistência reais + autorização + erros/recuperação + documentação + testes atuais + evidência do perfil homologado. Toda pendência externa tem responsável, entrada faltante e teste preparado. Não remover um módulo do escopo apenas para declarar conclusão.

Entregar ao final: resumo do que mudou e por quê; mapa das novas telas; matriz de papéis/capacidades; contratos/OpenAPI/Postman; diffs/commits/PRs; testes e limitações; instruções de configuração; plano de implantação e retorno; roteiro CCLX/JRC; checklist para aceite produtivo. Não publicar nem enviar credenciais a terceiros nesta tarefa.

Comece pela descoberta e mostre uma síntese curta do estado real e das dependências. Em seguida, avance para as alterações e testes da primeira entrega autorizada. Mantenha checkpoints para concluir o programa sem perder contexto.
