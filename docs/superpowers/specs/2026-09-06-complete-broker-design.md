# Broker completo JRC — expansão do produto

**Origem:** escopo e sequência aprovados pelo usuário em 2026-09-06, com autorização para planejar e construir.
**Estado:** especificação de evolução; não constitui declaração de funcionalidades entregues.
**Base:** arquitetura de 2026-09-03 e Incrementos 1 e 2 da Fase 1.

## Decisão e precedência

O produto passa a incluir administração de plataforma, mensageria, Meta oficial/templates, integração Typebot, canvas de bots JRC, atendimento e operação comercial. Esta decisão amplia as exclusões de chatbot e atendimento da especificação original; não altera retroativamente os critérios dos incrementos já construídos. O núcleo do broker e o motor conversacional permanecem módulos separados no mesmo monorepo.

Manter Node 24.19.0, TypeScript strict, Fastify, PostgreSQL, Drizzle com migrations SQL, Zod, React/Vite e Vitest. Não migrar para microsserviços ou Go. Workers são processos separados do mesmo produto. Inbox/outbox PostgreSQL é a fonte durável; RabbitMQ é a fila prevista pela arquitetura superior, e Redis continua responsável por controles efêmeros. Não escolher uma segunda fila concorrente por conveniência.

## Fronteiras e segurança

- Toda operação de cliente deriva organization_id da identidade autenticada. RLS com SET LOCAL em transações curtas; nenhuma chamada externa dentro da transação.
- OWNER continua limitado à própria organização. Administração JRC exige concessão explícita separada, verificável no servidor e revogável. Não promover todos os OWNER nem conceder privilégio por domínio de e-mail.
- Nenhuma credencial de plataforma, conteúdo de conversa, desafio ou token em logs/artefatos. Não colocar senha em argumentos de comandos.
- Navegador acessa exclusivamente a API JRC. Evolution permanece encapsulada e privada. META e BAILEYS publicam capacidades efetivas; recurso não suportado é rejeitado.
- Preservar main, gitlink/código upstream e avisos. Staging, commit, push, PR, merge, deploy e alterações de secrets GitHub continuam exigindo autorização específica.
- Não usar números de clientes para teste. Pareamento humano, Meta, SMTP, infraestrutura e cobrança reais exigem recursos autorizados; ausência desses recursos não será rotulada como sucesso.

## Administração e identidades

Separar /administracao/clientes da operação /conexoes. Criar, listar e suspender organizações; consultar usuários, conexões e saúde sem leitura irrestrita de conteúdo. Exigir confirmação e auditoria em suspensão. Privilégios de plataforma não entram em API keys de tenant.

Primeiro operador de plataforma é concedido por comando interno com credencial operacional; nenhuma inscrição pública. Sessão administrativa exige reautenticação e MFA antes de produção. Contas de cliente utilizam convite de uso único e prazo limitado; tokens de convite, confirmação de e-mail e recuperação são armazenados por hash. Consumo atômico e revogação de sessões ao redefinir senha. E-mail já existente é vinculado somente mediante fluxo explícito; nunca redefinir sua senha para cadastrar outro cliente.

Cadastro deve criar atomicamente organização, membership OWNER e provider_account BAILEYS lógico, reutilizando invariantes existentes. Envio de convite ocorre depois do commit por outbox; falha de SMTP fica visível e pode ser repetida sem duplicar cliente.

## Conexões e mensagens

Modalidades explícitas: QR, código de pareamento, Meta oficial e coexistência elegível. Não confundir API key com desafio de dispositivo. O diagnóstico inicial verifica estado local/upstream, validade do desafio, formato do número e instruções apresentadas; código 401 de desconexão isolado não comprova a causa do pareamento rejeitado.

Saída: validar identidade, capacidade, consentimento/política aplicável, quota e idempotência; persistir mensagem/outbox; responder 202; worker despacha fora da transação. Repetições após resposta incerta não prometem exactly-once no provider: manter estado UNKNOWN e reconciliar quando suportado, evitando retries cegos.

Entrada: verificar assinatura/autenticação específica do provider, resolver instância por identificador registrado, persistir inbox com unicidade e responder rapidamente. Não confiar em organization_id do payload. Eventos fora de ordem não regridem status. Anexos têm tamanho/tipo limitados, storage privado, autorização e expiração.

Webhooks de cliente: assinatura com timestamp, rotação de segredo, retry limitado, DLQ e reprocessamento auditado. URLs externas e blocos HTTP/Typebot exigem controle de SSRF, DNS/IP privado, redirects, timeout e limite de resposta.

## Meta e templates

Implementar provider Meta em adapter próprio, versão Graph explícita/configurada e validação de credenciais, assinatura e permissões. Onboarding por Embedded Signup com state de uso único vinculado ao usuário/organização; troca de código somente no servidor. Confirmar acesso aos ativos retornados antes de associá-los ao tenant. Modelar identificadores conforme versão oficialmente verificada, sem assumir que um identificador arbitrário pertence ao cliente.

Templates: rascunho, submissão, sincronização e exibição de estados aprovados/rejeitados/pausados; nome, idioma, categoria, componentes e variáveis. Aprovação pertence à Meta. Políticas de envio, capacidades, tarifas e elegibilidade são verificadas na documentação oficial da versão adotada e não ficam fixadas por suposição.

## Typebot e canvas

TypebotAdapter recebe eventos canônicos e devolve comandos de mensagem. Uma sessão por organização, conexão, contato e bot; fila ordenada por conversa e deduplicação. Pausa para humano tem precedência. Integrar API externa não autoriza incorporar/redistribuir o editor Typebot sem análise de licença.

Canvas JRC é editor próprio de grafo versionado. Primeira versão: início, texto, pergunta, condição, variável, chamada HTTP restrita, template, transferência humana e fim. Validar referências, portas, alcançabilidade e limites de loops antes da publicação. Rascunho é mutável; versão publicada é imutável. Conversas iniciadas permanecem na versão fixada. Não executar JavaScript arbitrário do cliente no servidor ou navegador.

Inbox de atendimento mantém contatos, conversas, responsáveis, filas, notas e alternância humano/bot. Troca de tenant limpa caches e cancela requisições. Histórico e mídia seguem retenção definida e permissões.

## Definição de broker completo para esta entrega

Dois clientes cadastrados pela console operam isoladamente; pelo menos uma conexão oficial Meta e uma Baileys enviam/recebem texto e mídia; templates reais sincronizam; bot Typebot e bot do canvas executam jornadas completas; atendente assume sem disputa com bot; integrações recebem eventos assinados; cotas funcionam; backup é restaurado e falhas são recuperadas. Calling, campanhas em massa e CRM completo são trilhas separadas, não requisitos implícitos de paridade.

Não declarar paridade total com produtos de terceiros sem inventário comparativo versionado. Teste automatizado com fake, smoke de engine e homologação humana são evidências diferentes.
