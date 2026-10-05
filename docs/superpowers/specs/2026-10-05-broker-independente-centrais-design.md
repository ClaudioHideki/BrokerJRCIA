# Broker independente e centrais — desenho de desenvolvimento

Data: 05/10/2026. Estado: desenho para execução incremental; não comprova implantação.
Origem: pedido do usuário para estruturar e iniciar o desenvolvimento do Broker independente, JRC Conversas multitenant e Chatwoot externo.

## 1. Continuidade e decisões

Este documento complementa os desenhos de 06/09 e 29/09/2026. Aproveitar os planos R1–R8, U1–U7 e A1–A8 existentes; nenhuma funcionalidade será reescrita apenas para acomodar uma nomenclatura nova.

Atualizações de escopo expressamente solicitadas:
- Operação independente inclui automação e atendimento humano no próprio Broker.
- Integração deve atender qualquer tenant autorizado do JRC, além de instalações externas compatíveis.
- Mensagens enviadas pelo aparelho e grupos WhatsApp entram no programa.
- Chamadas WhatsApp ganham trilha própria de viabilidade, desenvolvimento e homologação.
- Canal originalmente conectado na central deve poder usar o mesmo runtime canônico, em fase própria.
- Motor e APIs são validados primeiro no Broker; interfaces Flow/QR vêm depois. A homologação da jornada final ocorre após a integração dessas interfaces. Aceite do motor não equivale a aceite do produto final.

Stack mantida: Node 24.19.0, TypeScript strict, Fastify, PostgreSQL/Drizzle, Redis, React/Vite, Zod, Vitest e Playwright. Reutilizar workers, inbox/outbox e contratos; nenhuma troca geral de stack ou atualização de dependências.

## 2. Modos e origem do transporte

| Modo | Executor | Catálogo e atendimento humano |
| --- | --- | --- |
| STANDALONE | Broker | Times, agentes, filas e etiquetas locais autorizados |
| JRC_MANAGED | Broker | Account/Inbox do tenant JRC vinculado |
| CHATWOOT_EXTERNAL | Broker | Account/Inbox da instalação externa aprovada |

Os nomes acima são decisões de produto propostas, não valores já implantados no banco.

O transporte é outra dimensão:
- BROKER_TRANSPORT: número conectado pelo Broker; a central recebe espelhamento e devolve respostas humanas.
- CENTRAL_TRANSPORT: número conectado originalmente na central; eventos acionam o Broker e respostas saem pela API da central.
- Cada caixa tem um caminho autoritativo de envio. Nunca enviar a mesma resposta diretamente e pela central.
- Sem central configurada: controle local válido. Central configurada e indisponível: preservar pendências e bloquear efeitos que dependem de confirmar controle remoto. Nunca converter indisponibilidade em modo independente silenciosamente.

## 3. Isolamento e segurança

Escopo canônico: organização Broker + conexão + instalação normalizada + Account + Inbox + revisão do vínculo/credencial. IDs iguais em instalações distintas não são intercambiáveis.
- Derivar organização da sessão ou autenticação do webhook; ignorar organization_id não confiável.
- Revalidar papel, vínculo e capacidade no servidor em cada ação.
- RLS, chaves de cache e locks incluem organização. Dados de mídia e credenciais permanecem privados.
- Evitar conflitos de propriedade: mesmo destino/inbox não pode ser reivindicado por duas empresas Broker sem procedimento explícito de transferência.
- Tokens restritos à conta quando possível. Não exigir token global da plataforma para operações comuns.
- URL externa aprovada, HTTPS e controles existentes contra SSRF, redirecionamentos e DNS para redes privadas.
- Troca/revogação de token invalida caches, sessões delegadas e comandos ainda não despachados.
- Credenciais, dados reais de clientes, telefones e estado de pareamento não entram em documentos versionados ou fixtures.
- Publicação de release em produção exige tarefa de release aprovada; desenvolvimento local não autoriza deploy.

## 4. Catálogos e configuração

Reutilizar attendance-catalog: times, agentes, participação na caixa, etiquetas, atributos, horários/fuso, bot, saudação e atribuição automática.
A central é referência para seu catálogo; o catálogo local só governa STANDALONE. Etiquetas classificam e não transferem sem regra explícita.
Um agente fora da caixa não é destino válido. Time sem atendentes elegíveis gera fila/contingência visível, nunca falso atendimento.
Importação entre empresas exige remapear referências, credenciais e destinos.

Assistente do Broker:
1. Escolher modo e origem do transporte.
2. Validar URL, conta e credencial.
3. Conectar ou selecionar número; confirmar identidade.
4. Criar/adotar caixa sem sobrescrever webhook existente silenciosamente.
5. Consultar catálogo e selecionar destino humano.
6. Escolher automação publicada e versão.
7. Executar diagnóstico e teste controlado.
8. Ativar após requisitos obrigatórios atendidos.

Diagnóstico distingue SUPPORTED, UNSUPPORTED e UNVERIFIED; ausência de permissão/timeout não equivale a ausência de recurso. Exibir quando a evidência foi coletada e para qual versão/revisão.

## 5. Motor e controle de atendimento

Reutilizar BOT_ACTIVE, WAITING_INPUT, HANDOFF_PENDING, WAITING_HUMAN, HUMAN_ACTIVE, RESOLVED, ADMIN_PAUSED.
Estados do protocolo remoto (READY/HUMAN/RECONCILE etc.) são outra dimensão; não mudar seu significado para contornar um bloqueio.

Invariantes:
- Um executor por caixa e um ciclo ativo por conversa.
- Humano prevalece sobre efeito automático ainda não despachado.
- Nenhum evento pending isolado libera o bot.
- Retomar exige ação autenticada, revisão esperada e destino explícito: continuar, menu ou nova sessão.
- Continuação exige cursor compatível; sessão inexistente/encerrada não recebe cursor inventado.
- Nova sessão fixa versão publicada e invalida efeitos pendentes de ciclos anteriores; não reproduz mensagens antigas.
- Conversa resolvida respeita política configurada de criar nova/reabrir; verificar o comportamento efetivo no adaptador.
- Comandos distribuídos são persistentes: reservar em transação curta, executar HTTP fora dela, confirmar em nova transação.
- Timeout após escrita remota produz resultado desconhecido, com reconciliação; nunca repetir cegamente.
- Mudança de revisão, credencial, caixa ou humano durante a operação impede finalização como sucesso.
- Não há garantia de transação atômica entre Broker e Chatwoot. Documentar/testar a janela de concorrência remota e manter o bloqueio quando a evidência for insuficiente.

Retomada proposta:
1. Validar usuário e ler estado local/remoto atual.
2. Reservar operação idempotente e manter bot bloqueado.
3. Aplicar mudança remota compatível (estado/atribuição), quando necessária.
4. Ler de volta; confirmar escopo, identidade e ausência de intervenção humana posterior observada.
5. Revalidar revisões; atualizar sessão, controle e modo local juntos.
6. Liberar somente o ciclo escolhido. Operação incerta continua bloqueada com ação indicada.

A rota antiga de mode não pode ser um segundo atalho. Para integração remota, exigir novo comando coordenado e retornar erro orientado quando faltarem revisão/destino; manter resposta humana manual pela política existente.

## 6. Flow funcional

Definição e catálogo versionados compartilhados. Editor, validação, simulador e executor usam os mesmos contratos.
Catálogo de atendimento: início/fim, texto/mídia compatível, pergunta, menu, condição, variável, horário, silêncio, HTTP autorizado, IA delimitada, transferência, nota, etiqueta, atributo, resolução.
Cada bloco anunciado exige formulário, validação de portas, executor, saídas de falha, simulador e teste real compatível.
Versões publicadas imutáveis; sessões fixadas à sua versão. Troca de versão não reinicia conversa existente silenciosamente.
JSON JRC tem esquema, exemplos, limites e relatório de importação. n8n é conversão parcial; nós incompatíveis impedem publicação do caminho executável. Jade é referência de capacidades, não promessa de conversão integral.

## 7. Aparelho, grupos e chamadas

### Aparelho

Classificar entrada de cliente, saída do Broker, saída observada do aparelho, sistema e histórico.
Deduplicação usa IDs do provedor e vínculo persistido. Um fromMe sem correlação ainda pode ser eco atrasado: persistir/reconciliar antes de declarar origem humana. Nunca reenviar saída observada.
Espelhar autor/origem sem inventar identidade de agente; aplicar pausa quando a origem humana for confirmada. Histórico importado não dispara automação.

### Grupos WhatsApp

Entidade própria com JID, nome, participantes e vínculo ao número/organização; distinta de grupo econômico e de time.
Listar por conexão, habilitar grupos explicitamente, persistir remetente participante, controlar permissão de envio e deduplicar.
Bot fica desligado por padrão nos grupos; habilitação define quais mensagens podem disparar e limites contra loops.
Chatwoot externo exige matriz de representação: não anunciar equivalência de interface de grupo sem teste naquela versão. Sem suporte confirmado, mostrar indisponibilidade na central e preservar operação suportada no Broker.

### Chamadas

Trilha própria; QR de mensagens não comprova voz.
Verificar transporte efetivo, habilitação do número, edição/versão, consentimento e infraestrutura de áudio.
Oferecer capacidade de fazer/receber chamadas apenas depois de comprovar toque, aceite, áudio bidirecional, encerramento, concorrência e registro correto.
Notificação de chamada, rejeição de chamada e atendimento com áudio são capacidades diferentes.
Prova inicial usa integração oficial documentada quando elegível. Ponte de voz por outro provedor exige evidência específica; não pressupor suporte da Evolution instalada.

## 8. Interfaces na central

Flow: editor delega salvar/publicar/vincular ao Broker; não executa um segundo motor Rails.
QR: usa controle e grants existentes; QR/token temporários, restritos à caixa e ao operador.
JRC permite módulo próprio. Chatwoot externo pode usar Dashboard App/portal compatível; paridade de menu nativo depende da versão/extensão instalada.
Executar cutover por caixa com propriedade exclusiva, rollback e preservação de sessões. Ausência do módulo na central não impede uso do console Broker.

## 9. Observabilidade e definição de pronto

Separar transporte conectado, central validada, automação publicada, execução autorizada e entrega confirmada.
Para execução bloqueada, informar causa, último evento/revisão, correlação e ação; não incrementar tentativas como se houvesse envio.
Registrar commit, imagens efetivas, migrations, configuração não secreta, tipo de teste e evidência por capacidade.
Pronto significa 100% dos testes obrigatórios do perfil de release aprovados, zero falhas críticas conhecidas e limitações declaradas. Não significa compatibilidade universal com qualquer fork/provedor.

## Fontes e continuidade

- [Plano anterior](../plans/2026-09-29-broker-first-completion.md).
- [Catálogo existente](../../integrations/chatwoot-attendance-catalog.md).
- [Integração externa existente](../../operations/chatwoot-external.md).
- [AgentBots Chatwoot](https://www.chatwoot.com/hc/user-guide/articles/1677497472-how-to-use-agent-bots).
- [Chamadas Chatwoot](https://www.chatwoot.com/hc/user-guide/articles/1779871708-connecting-whats_app-voice-channel).
- [Consulta de grupos Evolution](https://docs.evoapicloud.com/api-reference/group-controller/fetch-all-groups).
Documentação de terceiros descreve capacidades gerais; versão instalada permanece objeto de homologação.
