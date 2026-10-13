# Bot de grupos WhatsApp — G3a QR

Esta entrega executa fluxos textuais em grupos comuns de uma conexão QR administrada pelo Broker. Usa o motor, as execuções, as outboxes e os workers existentes. Não cria outro executor ou daemon.

## Instalação

O pacote de código compõe a baseline canônica 0052, a dependência 0053_flow_delegation e a migração 0054_whatsapp_group_automation. A migração 0054 preserva as conversas individuais e separa os destinos GROUP e INDIVIDUAL. O journal deve conter os predecessores na ordem publicada; não execute um SQL avulso nem reaplique o overlay de testes.

Use o processo normal de migração e deploy do Compose publicado na main. Depois da migração, confirme conclusão/exit0 e consulte a prontidão estrutural da API com o procedimento operacional existente. A baseline esperada desta composição é 0054_whatsapp_group_automation. Um HTTP200 de /ready sozinho não comprova envio de mensagem.

Não há nova variável de habilitação G3. Conservam-se a configuração de conexão, a chave de assinatura dos eventos e AUTOMATION_RUNTIME_V2_ENABLED do motor existente. A configuração de grupos deve ser confirmada pelo servidor para a instância física atual.

## Configurar um grupo

1. Abra a caixa de entrada da empresa no Broker e conecte seu WhatsApp QR.
2. Publique um fluxo com início, mensagem, menu e fim e vincule essa versão à caixa.
3. Em grupos do WhatsApp, atualize o catálogo e selecione um grupo comum do qual o número conectado participa.
4. Abra Bot do grupo. Confira o grupo, a automação e a versão exibidos. Informe uma mensagem de início, por exemplo /menu, e clique Ativar bot neste grupo.
5. Envie essa mensagem exata a partir de outro número participante. Todos veem as respostas, mas somente o autor que iniciou essa sessão pode responder ao menu.

Atualizar os grupos também confirma a identidade e a configuração de eventos. Se a conexão tiver sido substituída, se a participação mudou ou se a observação do provedor falhar, a tela orienta atualizar/revalidar antes de ativar. ALLOW_GROUP_MESSAGES só é mostrado quando uma leitura válida comprova groupsIgnore=true. O Broker não altera silenciosamente essa configuração no Evolution; permita mensagens de grupos na configuração da instância e atualize o catálogo novamente.

Uma versão publicada diferente não altera a versão de uma sessão que já está em execução. Autor, identidade física, versão e ciclo de ativação ficam registrados. Mensagens de outros participantes não avançam essa sessão. Não se presume equivalência entre identificadores PN e LID.

Para grupos selecionados com bot configurado, o worker existente renova o catálogo antes de sua validade terminar. Não é necessário atualizar manualmente a cada cinco minutos. A renovação lê o provedor, revalida a autoridade da caixa após I/O e preserva os controles de pausa humana; não muda configuração do provedor nem repete envios incertos. Falhas conservam o estado desatualizado, com intervalo mínimo entre tentativas. Troca de número, saída/reentrada ou mudança de autoridade ainda exigem a revalidação indicada na tela.

A renovação processa uma caixa elegível por empresa a cada passagem, com antecedência de dois minutos e limite de 45 segundos por consulta. Motores lentos ou muitas caixas vencendo juntas podem exceder essa antecedência; nesse caso o bot aguarda dados atuais. A medição em infraestrutura real ainda é necessária para dimensionar capacidade.

## Atendimento humano e resultado incerto

OWNER e ADMIN podem ativar, pausar e retomar. OPERATOR pode consultar. Use Pausar bot para atendimento humano e depois Retomar bot neste grupo. A retomada exige estado/revisão atuais e não repete mensagens de uma sessão antiga. Saída e reentrada do número ou mudança de conexão exigem revalidação explícita.

O envio é registrado como DISPATCHED antes do POST no provedor. Se a confirmação se perder, o estado passa a UNKNOWN e não há reenvio automático. Confira o WhatsApp. A decisão Encerrar tentativa sem reenviar exige motivo e confirmação, registra auditoria e não declara entrega. Um envio ainda DISPATCHED não pode ser encerrado por esse controle enquanto estiver em andamento. Observações pendentes exigem tratar o conjunto exato de tentativas relacionado.

## Suporte e homologação

Esta etapa suporta texto e menu do transporte QR do Broker em grupos comuns. Comunidades e grupos de anúncios, mídia, menções, enquetes, chamadas, IA, subfluxos e ações de contatos não são implementados por este executor de grupos. A interface indica os blocos suportados antes da ativação.

G3b, a preservação de grupos na central JRC Conversas/Chatwoot, permanece pendente de um adapter de grupo comprovado. Este pacote não converte grupo em contato telefônico nem anuncia transporte Meta ou CENTRAL_TRANSPORT como suportado para grupos.

Os testes candidatos comprovam banco/isolamento, ingresso assinado, motor único, outboxes, workers, HTTP e interface com transporte sintético. Depois de publicar e instalar, homologue no grupo exclusivo de teste: início, menu, resposta do autor, outro participante, pausa/retomada, desconexão/reconexão, evento duplicado e resultado incerto. Registre versões, IDs de correlação e resultado observado. Teste local ou imagem publicada não equivale a homologação no WhatsApp real.
