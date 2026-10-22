"""Build the public integration manual from the same filtered OpenAPI used by Swagger.

Run export-guide.mjs first. ReportLab is an authoring dependency, not a runtime dependency.
"""
import hashlib
import json
from pathlib import Path
from html import escape
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle, KeepTogether

ROOT = Path(__file__).resolve().parents[2]
DATA = json.loads((ROOT / 'tmp/pdfs/contracts.json').read_text(encoding='utf-8'))
OUT = ROOT / 'scripts/docs/assets/guia-api-jrc.pdf'
OUT.parent.mkdir(parents=True, exist_ok=True)
NAVY, BLUE, LIGHT = colors.HexColor('#14385c'), colors.HexColor('#1269bc'), colors.HexColor('#edf4fb')
styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name='BodyJRC', fontName='Helvetica', fontSize=9.4, leading=14, textColor=NAVY, spaceAfter=8))
styles.add(ParagraphStyle(name='TitleJRC', fontName='Helvetica-Bold', fontSize=30, leading=36, textColor=NAVY, spaceAfter=20))
styles.add(ParagraphStyle(name='H1JRC', fontName='Helvetica-Bold', fontSize=20, leading=25, textColor=NAVY, spaceAfter=13))
styles.add(ParagraphStyle(name='H2JRC', fontName='Helvetica-Bold', fontSize=12, leading=17, textColor=BLUE, spaceBefore=10, spaceAfter=7))
styles.add(ParagraphStyle(name='SmallJRC', fontName='Helvetica', fontSize=8, leading=11, textColor=NAVY, spaceAfter=5))
styles.add(ParagraphStyle(name='CodeJRC', fontName='Courier', fontSize=7.5, leading=10.5, textColor=NAVY, backColor=LIGHT, borderPadding=9, spaceBefore=4, spaceAfter=11, wordWrap='CJK'))
story = []
def p(text, style='BodyJRC'):
    story.append(Paragraph(text, styles[style]))
def h(text): p(text, 'H2JRC')
def page(title):
    if story: story.append(PageBreak())
    p(title, 'H1JRC')
def code(text): p(escape(text).replace('\n', '<br/>').replace(' ', '&#160;'), 'CodeJRC')
def table(headers, rows, widths=None):
    data = [[Paragraph(escape(str(v)), styles['SmallJRC']) for v in row] for row in [headers] + rows]
    t = Table(data, colWidths=widths, hAlign='LEFT', repeatRows=1)
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),LIGHT),('LINEBELOW',(0,0),(-1,0),.8,BLUE),
      ('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),8),('RIGHTPADDING',(0,0),(-1,-1),8),
      ('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),6),('LINEBELOW',(0,1),(-1,-1),.25,colors.HexColor('#dbe5ef'))]))
    story.append(t); story.append(Spacer(1,8))

p('JRC BROKER / INTEGRAÇÕES', 'H2JRC')
story.append(Spacer(1,27*mm))
p('Guia da API<br/>para empresas', 'TitleJRC')
p('Conexões WhatsApp, mensageria, eventos assinados e integração com CCLX / Chatwoot.', 'H2JRC')
p('Edição técnica 22/10/2026. Contratos extraídos da revisão documentada do Broker. A publicação deste arquivo não certifica implantação no servidor nem homologação de um sistema externo.')
h('O que você recebe')
p('URL da instalação JRC, uma chave exclusiva da organização e documentação OpenAPI. A JRC opera o Broker e o motor de conexão. A empresa integra seu próprio backend e mantém suas telas, agentes, caixas e regras de negócio.')
p('Origem prevista: <b>https://jrc-broker.jrcws.cloud</b><br/>Portal previsto após o deploy: <b>/documentation/</b><br/>Chaves reais são entregues separadamente, por canal privado. Este guia não contém credenciais.')
p('Referência do contrato: ' + DATA['sourceHash'][:20], 'SmallJRC')

page('1. O que a empresa consegue fazer')
table(['Área','Disponível pelo perfil documentado'],[
 ['Conexões QR','Descobrir provedores do tenant; criar/listar instâncias; parear, consultar estado, reconectar e desconectar.'],
 ['Mensageria por chave','Ativar o canal QR; consultar canais, conversas e mensagens; enfileirar texto individual.'],
 ['Recebimento','Receber eventos em receptor HTTPS com HMAC ou ler eventos por cursor, sem exigir URL Chatwoot previamente.'],
 ['Controle Chatwoot opcional','Vincular uma Account remota, parear número, confirmar identidade, definir agentes e acompanhar operações, mediante credencial específica.'],
 ['Interface dentro do CCLX','Pacote adaptador de QR para incorporação ao host. Instalação exige integração com sessão, permissões e mapeamento do CCLX.']],[39*mm,126*mm])
h('Limites do acesso genérico atual')
p('O envio por chave neste perfil é de <b>texto individual pelo QR</b>. Inclui download privado de anexo, mas não envio de mídia, envio em grupos, templates Meta nem administração de Flows. Outras funções do console e integrações diretas usam contratos e permissões próprios. Não assuma que qualquer chave autoriza todas as rotas do Broker.')
p('A integração oficial Meta depende do cadastro, ativos, permissões e onboarding correspondentes. A API de QR não é uma substituição automática do fluxo oficial. O transporte Evolution é interno: o parceiro chama a API JRC, sem receber a chave global do motor.')
h('Critério de funcionamento')
p('HTTP 200/202, build aprovado ou container saudável não comprovam entrega ao WhatsApp. A POC deve demonstrar pareamento, entrada, saída, estados, idempotência, retomada e isolamento entre empresas com números de homologação.')

page('2. Arquitetura para o CCLX')
code('Interface CCLX\n  -> backend/adaptador CCLX (sessão e permissões locais)\n  -> API HTTPS JRC (chave do tenant)\n  -> Broker / fila durável / motor QR / WhatsApp\n\n+WhatsApp -> Broker -> webhook HMAC ou polling\n+  -> inbox durável CCLX -> Pub/Sub local\n+  -> camada de mensageria / caixa / agente no CCLX'.replace('\n+','\n'))
p('Informação fornecida pela equipe do CCLX em 22/10: mensageria parcialmente baseada em Chatwoot 3.x; demais módulos em outro banco; integração por APIs e filas Pub/Sub; possível migração futura para 4.x. A versão exata, a tecnologia da fila e os pontos de extensão ainda precisam ser confirmados.')
h('Responsabilidades')
table(['JRC','CCLX'],[
 ['Broker, contrato REST, isolamento de tenant, persistência e entrega de eventos.','Guardar a chave no backend e autenticar seus agentes.'],
 ['Conectar o número e observar estados do transporte.','Mapear instanceId/channelId/conversationId JRC para Account, inbox e conversation locais.'],
 ['Expor o QR e operações documentadas.','Incorporar a interface QR e respeitar quem pode administrar cada caixa.'],
 ['Assinar e repetir webhooks dentro dos limites.','Verificar HMAC, persistir eventId único, publicar na fila e evitar loop/duplicação.']],[82*mm,83*mm])
p('Não é necessário compartilhar banco PostgreSQL, Redis, fila interna, SSH ou chave Evolution. O Broker não escreve diretamente no banco do CCLX. Para o caminho genérico, URL/Account/token Chatwoot não são pré-requisitos da emissão da chave.')
h('O que falta confirmar com o CCLX')
p('Versão exata 3.x; autenticação e permissões do host; API local de contatos/conversas/mensagens; tecnologia e contrato Pub/Sub; formato dos IDs; receptor HTTPS ou escolha inicial por polling; mapeamento das caixas e dos cinco números da POC.')

page('3. Acesso e configuração inicial')
table(['Escopo','Uso'],[['instances:read','Consultar provedores e instâncias.'],['instances:write','Criar, parear e desconectar instâncias.'],['messaging:read','Consultar canais, conversas e mensagens.'],['messaging:send','Ativar canal (também exige instances:write) e enviar texto QR.'],['webhooks:manage','Cadastrar/revogar receptor, consultar eventos e entregas.']],[54*mm,111*mm])
code('GET /v1/provider-accounts?provider=BAILEYS&limit=100\nAccept: application/json\nX-JRC-API-Key: SUA_CHAVE_PRIVADA')
p('A chave identifica a organização. Não envie organizationId no corpo para escolher outro tenant. Os IDs de recursos são UUIDs do Broker, não IDs globais do Evolution. Se a lista de contas de provedor estiver vazia, a JRC precisa provisionar o acesso do tenant antes de criar instâncias.')
p('Validade sugerida para a POC: 15 dias. A chave é revogável e os novos escopos são explícitos. Não guardar a chave em JavaScript público, URL, repositório, print ou pacote de documentação. O Swagger mantém a autorização somente na memória da aba.')
h('Usar o Swagger')
p('Abrir /documentation/, escolher Conexões, Mensageria ou Eventos e clicar Authorize. Informar somente uma credencial por requisição. Escrita fica desabilitada inicialmente; habilitá-la e clicar Execute executa a operação real. O portal não cria conexões ou envia mensagens automaticamente. Há downloads OpenAPI, consultas Postman e este PDF.')

page('4. Primeiro número: parear e ativar')
h('Passo 1 - Escolher uma conta e criar instância')
code('GET /v1/provider-accounts?provider=BAILEYS&limit=100\n\nPOST /v1/instances\nIdempotency-Key: poc-instancia-01\nContent-Type: application/json\n\n{"name":"POC CCLX", "provider":"BAILEYS",\n "providerAccountId":"UUID_DA_CONTA_RETORNADA"}')
p('Guardar response.instance.id como instanceId. Verificar pending, operationId e reconciliationRequired. Não gerar outra intenção de criação ao receber timeout ou resultado incerto.')
h('Passo 2 - Solicitar QR ou reconexão')
code('POST /v1/instances/INSTANCE_ID/connect\nIdempotency-Key: poc-pareamento-01\nContent-Type: application/json\n\n{}\n\nGET /v1/instances/INSTANCE_ID/status')
p('Ler action.type. QR_CODE usa action.encoding, value e expiresAt; PAIRING_CODE apresenta code. NONE pode indicar conexão já existente ou operação pendente. Não renderizar qualquer string como URL arbitrária. Reconectar usa o mesmo endpoint /connect, com uma intenção explícita e idempotência própria; não existe rota /reconnect no contrato de instâncias.')
h('Passo 3 - Ativar o canal para mensageria')
code('POST /v1/messaging/instances/INSTANCE_ID/partner-activate\nIdempotency-Key: poc-canal-01\nContent-Type: application/json\n\n{}')
p('Guardar <b>response.id</b> como channelId: o canal vem em objeto plano, sem wrapper channel. Ativar mensageria não liga bots. Consultar os canais permite recuperar o vínculo pela instanceId.')

page('5. Receber e responder')
h('Recebimento por consulta periódica')
code('GET /v1/partner-events?after=0&limit=50\n\n# Persistir eventos e o nextCursor retornado.\nGET /v1/partner-events?after=CURSOR_RETORNADO&limit=50')
p('Cursores são strings decimais. Não converter para Number em JavaScript. Persistir eventId único e cursor no backend; consultar até obter uma página sem avanço e repetir com intervalo controlado. Eventos históricos importados não são tratados como novas mensagens acionáveis.')
h('Responder a uma conversa do Broker')
code('POST /v1/messaging/channels/CHANNEL_ID/partner-text\nIdempotency-Key: cclx-resposta-123\nContent-Type: application/json\n\n{"conversationId":"CONVERSATION_ID_JRC",\n "text":"Mensagem de homologação"}')
p('Alternativa: phoneNumber E.164 em vez de conversationId, nunca ambos. Texto: 1 a 4096 caracteres. IDs da conversa local do CCLX não podem ser enviados como UUID da conversa JRC. Usar mapa durável entre os sistemas.')
p('<b>202 significa enfileirado.</b> Consultar mensagens e eventos para SENT/DELIVERED/READ ou falha. A chave é revalidada no despacho: expiração, revogação, exclusão ou remoção do escopo bloqueiam envio pendente. Revogação não recolhe uma requisição já enviada ao provedor.')
h('Evitar loop')
p('Não reenviar mensagens recebidas da JRC de volta ao WhatsApp. Guardar a origem e o ID externo; mensagens espelhadas geram atualização local, não uma nova intenção de saída. Uma intenção do agente usa uma única chave idempotente, inclusive após timeout.')

page('6. Webhooks: assinatura e retomada')
code('POST /v1/partner-webhooks\nIdempotency-Key: cclx-receptor-01\nContent-Type: application/json\n\n{"url":"https://backend.example/hooks/jrc"}')
p('Guardar response.endpoint.id e response.signingSecret. O segredo é independente da chave de API. Listagens não devolvem segredos. A URL exige HTTPS público, porta 443, DNS e certificado válidos, sem query, fragmento, usuário ou senha. Redirects e endereços privados são rejeitados. Até cinco endpoints ativos por tenant.')
table(['Evento','Significado'],[['message.received','Nova mensagem recebida no Broker.'],['message.created','Mensagem de saída registrada no Broker, inclusive origem observada.'],['message.status','Mudança observada no estado da mensagem.'],['connection.status','Mudança de estado de conexão QR ou Meta.']],[51*mm,114*mm])
code('X-JRC-Event-Id: UUID_IMUTAVEL\nX-JRC-Timestamp: UNIX_SEGUNDOS\nX-JRC-Signature: sha256=HEX_HMAC\n\nHEX_HMAC = HMAC_SHA256(signingSecret,\n  timestamp + "." + eventId + "." + exactRawBody)')
p('Validar bytes brutos antes de transformar JSON, comparar em tempo constante, conferir header eventId contra o envelope e aceitar timestamp com janela de cinco minutos. Persistir em inbox durável com chave única eventId antes do 2xx. Publicar no Pub/Sub a partir de outbox durável evita perder o evento entre confirmação HTTP e fila.')
p('Entrega ao menos uma vez, possivelmente fora de ordem. Até dez tentativas totais: falhas de rede, 5xx, 408, 425 e 429 permitem retry limitado. Outros códigos, incluindo redirect, são terminais. A JRC não guarda o corpo da resposta do receptor. Revogar uma chave de API não revoga o receptor; revogue ambos ao encerrar a integração.')
p('Retenção do feed: 30 dias. 409 EVENT_CURSOR_EXPIRED informa resetCursor/earliestCursor/lastPrunedCursor: reiniciar e conciliar com o estado das mensagens. Nunca inferir sucesso a partir de feed vazio.')

page('7. Erros, estados e operação segura')
table(['Código / estado','Como tratar'],[['400 / 422','Corrigir corpo, parâmetros ou formato conforme schema; não repetir indefinidamente.'],['401 / 403','Conferir validade, escopo e vínculo da chave. Não trocar tenant ou contornar a autorização.'],['404','Conferir ID, perfil de integração e disponibilidade; um recurso de outro tenant não fica acessível.'],['409','Conflito de revisão, identidade, idempotência ou cursor. Consultar e conciliar antes de agir.'],['429','Respeitar limites e backoff do cliente. Não criar múltiplas intenções para superar o limite.'],['502 / 503 / timeout','Consultar o estado da intenção existente e usar a mesma Idempotency-Key ao repetir a mesma operação.'],['UNKNOWN','Resultado incerto. Não gerar nova mensagem/chave para forçar envio; conciliar a operação.'],['DELIVERED no webhook','O receptor respondeu 2xx; não confundir com mensagem WhatsApp entregue.']],[50*mm,115*mm])
h('Aceite da POC')
p('1. Uma empresa e um número de homologação; chave com prazo e escopos mínimos.<br/>2. Parear, desconectar e reconectar pela interface incorporada.<br/>3. Receber mensagem e registrá-la na caixa correta do CCLX.<br/>4. Responder e observar os estados sem duplicação.<br/>5. Repetir a intenção com a mesma chave e simular queda do receptor.<br/>6. Comprovar isolamento de outro tenant, revogação e retomada por cursor.<br/>7. Confirmar limites de mídia, grupos, Meta e Flow antes de ampliar o escopo.<br/>8. Expandir até cinco números e iniciar o período acordado após aceite do percurso inicial.')
p('Sem acesso ao host do CCLX e sem números de homologação, o pacote pode ser testado por contratos e simulação, mas não é correto certificar a integração externa como concluída.')

page('8. Catálogo de endpoints')
p('As próximas páginas explicam cada operação dos perfis públicos. Tipos, campos obrigatórios, limites e respostas são derivados do mesmo OpenAPI do Swagger. Erros comuns de autenticação, autorização, indisponibilidade e limites também podem ocorrer em rotas legadas que documentam somente a resposta de sucesso.')
profile_names = {'instances':'Conexões QR', 'messaging':'Mensageria por chave', 'events':'Eventos e webhooks', 'chatwoot':'Controle Chatwoot opcional'}
operation_count = 0
for profile in ['instances','messaging','events','chatwoot']:
    doc = DATA['profiles'][profile]
    if profile == 'instances': h(profile_names[profile])
    else: page(profile_names[profile])
    p(doc['info']['description'])
    for route, methods in doc['paths'].items():
        for method, op in methods.items():
            if method not in ['get','post','put','delete','patch']: continue
            block_start = len(story)
            operation_count += 1
            guide = DATA['guides'][method.upper()+' '+route]
            p(guide['title'], 'H2JRC')
            code(method.upper()+' '+route)
            p(guide['purpose'])
            p('<b>Escopo:</b> '+escape(guide['scope']), 'SmallJRC')
            params = op.get('parameters', [])
            if params:
                p('<b>Parâmetros:</b> '+escape('; '.join(x['name']+' ('+x['in']+', '+('obrigatório' if x.get('required') else 'opcional')+')' for x in params)), 'SmallJRC')
            body = op.get('requestBody',{}).get('content',{}).get('application/json',{}).get('schema')
            if body:
                def short(schema):
                    if 'oneOf' in schema or 'anyOf' in schema:
                        return ' OU '.join(short(x) for x in schema.get('oneOf',schema.get('anyOf',[])))
                    props = schema.get('properties',{})
                    if props:
                        return ', '.join(k+(' *' if k in schema.get('required',[]) else '')+': '+('/'.join(v.get('enum',[])) if v.get('enum') and all(isinstance(x,str) for x in v['enum']) else v.get('type','objeto')) for k,v in props.items())
                    return '{}'
                p('<b>Corpo JSON:</b> '+escape(short(body))+' (* obrigatório). Ver schemas completos no Swagger.', 'SmallJRC')
            p('<b>Respostas declaradas:</b> '+', '.join(sorted(op['responses'])), 'SmallJRC')
            story.append(Spacer(1,9*mm))
            block = story[block_start:]
            del story[block_start:]
            story.append(KeepTogether(block))

page('9. Capacidades além da POC inicial')
p('A meta é um Broker completo, mas capacidade do motor, contrato JRC e homologação são provas diferentes. Não tratar uma rota existente ou um botão habilitado como prova de entrega. QR e Meta também têm capacidades distintas.')
table(['Recurso','Situação e próximo critério'],[
 ['Texto QR','Contrato por chave documentado. Provar ida/volta no número de homologação e estados reais.'],
 ['Mídia','Há transporte de imagem/áudio/vídeo/documento/figurinha no Broker. O perfil genérico de chave já permite download privado pelo ID da mensagem; ainda precisa de upload/envio, cotas e homologação específica.'],
 ['Campanhas','São envios individuais agendados. A ponte JRC exige contrato canônico de capacidade, intenção e recibo da revisão correspondente; não basta liberar uma checkbox.'],
 ['Grupos e histórico','Há caminhos próprios no Broker, com seleção e revisões. Não presumir catálogo de grupos completo, administração de participantes ou cópia integral do WhatsApp pelo perfil genérico.'],
 ['Flow / URA','Usar primeiro o editor no console Broker, com um executor por canal. Editor incorporado, catálogo remoto, transferência e retomada precisam de adaptação ao host CCLX. A chave QR/texto não autoriza gestão do Flow.'],
 ['Chamadas','Na referência Evolution fixada, offerCall tem a chamada real comentada e devolve um ID de exemplo. Voz exige transporte efetivo e validado; esse stub não comprova ligação.'],
 ['Outros tipos','Localização, cartão de contato, reação, enquete, lista e botões têm funções na referência Evolution. Cada tipo precisa de contrato, armazenamento/projeção, despacho e prova próprios no Broker.'],
 ['Monitoramento','Usar saúde, fila e diagnóstico. UNKNOWN exige conciliação. Eventos e Pub/Sub não autorizam repetir efeitos de envio.']],[35*mm,130*mm])
p('Modelo CCLX: uma organização Casa do Construtor CCLX, com uma instância por número. Usuários próprios usam o console Broker; o backend CCLX usa a chave do tenant. O CCLX relaciona agente/Account/caixa a instanceId e channelId; um agente pode atender várias caixas e um número pode ser compartilhado por agentes autorizados.')

page('10. Referências e verificação de versão')
p('Fonte contratual: docs/api/openapi.json e perfis públicos gerados em scripts/docs/public-api.mjs. A geração falha se uma rota selecionada desaparecer; a documentação não cria endpoints fictícios.')
p('Operações neste catálogo: '+str(operation_count)+'. Código dos contratos canônicos SHA-256: '+DATA['sourceHash'], 'SmallJRC')
p('Este manual deve acompanhar a mesma versão do Swagger e das imagens API/Web. A publicação no GHCR não atualiza o Dokploy automaticamente. O operador precisa aplicar as migrações exigidas pela revisão, atualizar todos os workers e conferir prontidão e logs.')
p('Documentação oficial de referência para o adaptador Chatwoot:<br/><link href="https://www.chatwoot.com/hc/user-guide/articles/1677839703-how-to-create-an-api-channel-inbox" color="#1269bc">Como criar uma caixa do tipo API</link><br/><link href="https://app.chatwoot.com/hc/user-guide/articles/1677693021-how-to-use-webhooks" color="#1269bc">Webhooks do Chatwoot</link>')
p('Essas referências descrevem o produto de origem e não certificam o fork/versão do CCLX. A versão exata e as adaptações devem ser verificadas no ambiente de homologação.')
def decorate(canvas, doc):
    canvas.setStrokeColor(colors.HexColor('#dbe5ef')); canvas.line(22*mm,281*mm,188*mm,281*mm)
    canvas.setFillColor(NAVY); canvas.setFont('Helvetica-Bold',8); canvas.drawString(22*mm,285*mm,'JRC BROKER | API PARA EMPRESAS')
    canvas.setFont('Helvetica',8); canvas.drawString(22*mm,13*mm,'22/10/2026 | Guia de integração - sem credenciais')
    canvas.drawRightString(188*mm,13*mm,str(doc.page))
SimpleDocTemplate(str(OUT), pagesize=(210*mm,297*mm), rightMargin=22*mm,leftMargin=22*mm,topMargin=25*mm,bottomMargin=23*mm,
    title='JRC Broker - Guia da API para empresas',author='JRC',subject='Integração CCLX, QR, mensageria e webhooks').build(story,onFirstPage=decorate,onLaterPages=decorate)
manifest = {'canonicalSha256': DATA['sourceHash'], 'guideSha256':hashlib.sha256((ROOT/'scripts/docs/operation-guide.mjs').read_bytes()).hexdigest(), 'pdfSha256':hashlib.sha256(OUT.read_bytes()).hexdigest(),'operationCount':operation_count,'edition':'2026-10-22'}
(OUT.with_suffix('.json')).write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
dest=ROOT/'output/pdf';dest.mkdir(parents=True,exist_ok=True)
(dest/OUT.name).write_bytes(OUT.read_bytes())
print(json.dumps({'pdf':str(OUT),'bytes':OUT.stat().st_size,'operations':operation_count}))
