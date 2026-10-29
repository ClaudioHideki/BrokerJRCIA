"""Compact API handout from the same filtered OpenAPI as Swagger.

Run export-guide.mjs after generating canonical OpenAPI. ReportLab is authoring-only.
"""
import hashlib
import json
import re
from html import escape
from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

ROOT = Path(__file__).resolve().parents[2]
DATA = json.loads((ROOT / 'tmp/pdfs/contracts.json').read_text(encoding='utf-8'))
OUT = ROOT / 'scripts/docs/assets/guia-api-jrc.pdf'
EDITION = '2026-10-29'
OPERATIONS = {method.upper() + ' ' + route: (profile, op)
              for profile, doc in DATA['profiles'].items() for route, methods in doc['paths'].items()
              for method, op in methods.items() if method in ('get', 'post', 'put', 'delete', 'patch')}
UUID = '11111111-1111-4111-8111-111111111111'
NAVY, BLUE, LIGHT = (colors.HexColor(v) for v in ('#14385c', '#1269bc', '#edf4fb'))
styles = getSampleStyleSheet()
for name, font, size, leading, after in (
    ('Body', 'Helvetica', 9, 12.2, 6), ('Title', 'Helvetica-Bold', 23, 27, 10),
    ('Heading', 'Helvetica-Bold', 11.4, 14.2, 6), ('Small', 'Helvetica', 8.1, 10.6, 4),
    ('Route', 'Courier-Bold', 8.1, 10.8, 3), ('Code', 'Courier', 7.8, 10.3, 7),
    ('Entry', 'Helvetica', 8.1, 10.6, 1.5), ('EntryRoute', 'Courier-Bold', 8.1, 10.8, 1.5),
):
    styles.add(ParagraphStyle(name='Broker' + name, fontName=font, fontSize=size, leading=leading,
        textColor=NAVY, spaceAfter=after, wordWrap='CJK',
        **({'backColor': LIGHT, 'borderPadding': 7, 'spaceBefore': 4} if name == 'Code' else {})))
story = []


def public_text(value):
    """Normalize host-specific editorial text without changing paths or schemas."""
    result = re.sub(r'CCLX|JRC\s*Conversa(?:s)?', 'sistema consumidor', str(value), flags=re.I)
    return result.replace('\u2011', '-').replace('\u2013', '-').replace('\u2014', '-')


def p(value, style='Body'):
    story.append(Paragraph(value, styles['Broker' + style]))


def text(value, style='Body'):
    p(escape(public_text(value)), style)


def h(value):
    text(value, 'Heading')


def page(value):
    if story:
        story.append(PageBreak())
    text(value, 'Title')


def code(value):
    p(escape(value).replace('\n', '<br/>').replace(' ', '&#160;'), 'Code')


def table(headers, rows, widths):
    cells = [[Paragraph(escape(public_text(v)), styles['BrokerSmall']) for v in row] for row in [headers] + rows]
    item = Table(cells, colWidths=widths, hAlign='LEFT', repeatRows=1)
    item.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), LIGHT), ('LINEBELOW', (0, 0), (-1, 0), .6, BLUE),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6), ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LINEBELOW', (0, 1), (-1, -1), .25, colors.HexColor('#dbe5ef'))]))
    story.extend([item, Spacer(1, 6)])


def resolve(schema, document):
    if '$ref' not in schema:
        return schema
    value = document
    for part in schema['$ref'][2:].split('/'):
        value = value[part.replace('~1', '/').replace('~0', '~')]
    return resolve(value, document)


def sample(schema, document, name=''):
    """Minimal synthetic example using actual request unions and property types."""
    schema = resolve(schema, document)
    for union in ('oneOf', 'anyOf'):
        if union in schema:
            return sample(schema[union][0], document, name)
    if 'const' in schema:
        return schema['const']
    if 'enum' in schema:
        return schema['enum'][0]
    kind = schema.get('type')
    if kind == 'object' or 'properties' in schema:
        return {key: sample(schema['properties'][key], document, key) for key in schema.get('required', [])}
    if kind == 'array':
        return [sample(schema.get('items', {}), document, name)]
    if kind in ('integer', 'number'):
        return max(1, schema.get('minimum', 0) + (1 if schema.get('exclusiveMinimum') is True else 0))
    if kind == 'boolean':
        return False
    if schema.get('format') == 'uuid':
        return UUID
    if schema.get('format') in ('uri', 'url'):
        return 'https://backend.example/hooks/broker'
    if schema.get('format') == 'date-time':
        return '2026-10-29T12:00:00Z'
    return {'text': 'Mensagem de teste', 'name': 'Canal de teste', 'instanceName': 'Canal de teste',
            'campaignId': 'campanha-teste', 'fileName': 'arquivo.pdf', 'mimeType': 'application/pdf',
            'sha256': 'a' * 64, 'caption': 'Arquivo de teste'}.get(name, 'exemplo')


def operation(key):
    profile, op = OPERATIONS[key]
    return DATA['profiles'][profile], op


def request_example(key, **overrides):
    document, op = operation(key)
    result = sample(op['requestBody']['content']['application/json']['schema'], document)
    result.update(overrides)
    # Wrap only at JSON punctuation outside strings, so copied UUIDs stay intact.
    raw = json.dumps(result, ensure_ascii=False, separators=(',', ':'))
    tokens, token, quoted, escaped = [], '', False, False
    for char in raw:
        token += char
        if char == '"' and not escaped:
            quoted = not quoted
        if char == ',' and not quoted:
            tokens.append(token)
            token = ''
        escaped = char == '\\' and not escaped
    tokens.append(token)
    lines, line = [], ''
    for token in tokens:
        if line and len(line + token) > 90:
            lines.append(line)
            line = '  '
        line += token
    return '\n'.join(lines + [line])


def schema_summary(schema, document):
    schema = resolve(schema, document)
    for union in ('oneOf', 'anyOf'):
        if union in schema:
            return ' OU '.join(schema_summary(item, document) for item in schema[union])
    if 'properties' in schema:
        return ', '.join(key + ('*' if key in schema.get('required', []) else '?')
                         for key in schema['properties']) or '{}'
    return schema.get('format', schema.get('type', 'objeto'))


def catalog(keys):
    for key in keys:
        document, op = operation(key)
        guide = DATA['guides'][key]
        start = len(story)
        text(key, 'EntryRoute')
        p('<b>' + escape(public_text(guide['title'])) + '</b>', 'Entry')
        text('Escopo: ' + guide['scope'] + ' | HTTP: ' + ', '.join(sorted(op['responses'])), 'Entry')
        params = [item for item in op.get('parameters', []) if item['in'] != 'path']
        if params:
            text('Parâmetros: ' + '; '.join(item['name'] + ('*' if item.get('required') else '?') + ' [' + item['in'] + ']' for item in params), 'Entry')
        contents = op.get('requestBody', {}).get('content', {})
        if 'application/json' in contents:
            text('JSON (* obrigatório; ? opcional): ' + schema_summary(contents['application/json']['schema'], document), 'Entry')
            p(escape('Exemplo: ' + request_example(key)).replace('\n', '<br/>'), 'EntryRoute')
        elif contents:
            text('Corpo: ' + ', '.join(contents) + ' (bytes do arquivo).', 'Entry')
        else:
            text(public_text(guide['purpose']).split('. ')[0].rstrip('.') + '.', 'Entry')
        story.append(Spacer(1, 4))
        block = story[start:]
        del story[start:]
        story.append(KeepTogether(block))


def keys_for(profile):
    return [key for key, (owner, _) in OPERATIONS.items() if owner == profile]


page('Broker | Guia técnico da API')
text('29/10/2026 | ' + str(len(OPERATIONS)) + ' operações públicas | GET, POST, PUT e DELETE', 'Heading')
text('Referência para integrar um backend à API HTTPS do Broker: conexões QR, texto, mídia privada, eventos e controle Chatwoot opcional. Os exemplos usam somente IDs sintéticos e variáveis de credencial.')
h('Acesso e convenções')
code('BASE_URL="https://broker.example"\n# Use a origem e a chave recebidas para sua instalação.\n# BROKER_API_KEY é uma variável privada do backend.\ncurl "$BASE_URL/v1/provider-accounts?provider=BAILEYS&limit=100" \\\n  -H "X-JRC-API-Key: $BROKER_API_KEY"')
text('A chave define o tenant; não envie organizationId para selecionar outra empresa. Use uma única credencial por requisição. Guarde a chave no backend. A documentação interativa está em /documentation/; Execute realiza a operação solicitada quando a escrita está habilitada.')
table(['Escopos genéricos', 'Permissão'], [
    ['instances:read / instances:write', 'Consultar / administrar conexões.'],
    ['messaging:read / messaging:send', 'Consultar canais, conversas e anexos / enviar texto.'],
    ['media:upload / media:send', 'Carregar e consultar arquivo / enviar referência com messaging:send.'],
    ['webhooks:manage', 'Gerir receptores e consultar eventos/entregas.'],
], [76 * mm, 98 * mm])
h('Criar, parear e ativar um canal QR')
code('POST /v1/instances\n' + request_example('POST /v1/instances') + '\n\nPOST /v1/instances/{id}/connect\n{}\nGET /v1/instances/{id}/status\nPOST /v1/messaging/instances/{id}/partner-activate\n{}')
text('Nos POST JSON: Content-Type: application/json e Idempotency-Key. Troque os UUIDs sintéticos pelos IDs retornados. Obtenha providerAccountId na primeira consulta; guarde instance.id. Exiba action QR_CODE/PAIRING_CODE apenas ao operador autorizado e aguarde CONNECTED. A ativação retorna o canal plano: response.id é channelId. Não ativa bot.')
h('Enviar texto individual')
code('POST /v1/messaging/channels/{id}/partner-text\n' + request_example('POST /v1/messaging/channels/{id}/partner-text'))
text('Texto: 1 a 4096 caracteres. conversationId ou phoneNumber E.164, nunca ambos. HTTP 202 admite na fila; acompanhe as mensagens e os eventos para SENT, DELIVERED, READ ou falha. Uma chave idempotente representa a mesma intenção, inclusive após timeout.')

page('Mídia privada | carregar e enviar')
text('Primeiro recorte: envio individual QR, provider BAILEYS e BROKER_TRANSPORT. Imagem, áudio, vídeo e documento; sem grupos, templates Meta, stickers, PTT ou chamadas neste perfil. Áudio aceito pelo contrato ainda exige validar codec/reprodução no sistema consumidor.')
h('1. POST binário - scope media:upload')
code('curl -X POST "$BASE_URL/v1/messaging/channels/$CHANNEL_ID/media" \\\n  -H "X-JRC-API-Key: $BROKER_API_KEY" \\\n  -H "Idempotency-Key: 22222222-2222-4222-8222-222222222222" \\\n  -H "Content-Type: application/octet-stream" \\\n  -H "X-JRC-Media-Mime: application/pdf" \\\n  -H "X-JRC-Media-Kind: document" \\\n  -H "X-JRC-Media-Name: arquivo.pdf" \\\n  --data-binary @arquivo.pdf')
text('X-JRC-Media-Name usa encodeURIComponent(nome). Envie bytes, sem base64, multipart ou URL remota. Limite global: 1 byte a 16 MiB; imagem até 5 MiB. MIME, assinatura dos bytes, kind e nome precisam ser compatíveis. O armazenamento é privado e sujeito à quota do tenant.')
document, upload_op = operation('POST /v1/messaging/channels/{id}/media')
upload_value = sample(upload_op['responses']['201']['content']['application/json']['schema'], document)
upload_value.update({key: value for key, value in {'status': 'READY', 'kind': 'document', 'fileName': 'arquivo.pdf', 'mimeType': 'application/pdf', 'byteSize': 4096}.items() if key in upload_value})
code('HTTP 201 - exemplo de metadados\n' + json.dumps(upload_value, ensure_ascii=False, indent=2))
h('2. GET metadados - reconciliar o estado')
code('GET /v1/messaging/channels/{id}/media/{mediaId}\nX-JRC-API-Key: $BROKER_API_KEY')
text('201 cria o recurso durável; não comprova bytes prontos nem envio. READY permite envio; STORING exige consulta/reconciliação; FAILED informa falha. GET exige media:upload e não refaz upload nem envia mensagens. Replay com mesma chave UUID e mesmos bytes/metadados retorna a mesma referência; alteração retorna 409. Não repita um PUT incerto com nova intenção.')
h('3. POST referência - messaging:send + media:send')
code('POST /v1/messaging/channels/{id}/partner-media\nContent-Type: application/json\nIdempotency-Key: 33333333-3333-4333-8333-333333333333\n\n' + request_example('POST /v1/messaging/channels/{id}/partner-media', caption='Arquivo de teste'))
text('Use mediaId de arquivo READY do mesmo tenant/canal. Caption é opcional, até 1024 caracteres. Nome, MIME e kind vêm do registro validado. HTTP 202 é fila; upload não implica envio. Chaves antigas não ganham os scopes novos. Revogação, expiração ou perda de scope impedem despacho pendente; um envio físico já efetuado não pode ser recolhido.')

page('Eventos | receber, confirmar e retomar')
h('POST - cadastrar receptor HTTPS')
code('POST /v1/partner-webhooks\nContent-Type: application/json\nIdempotency-Key: receptor-teste-01\n\n' + request_example('POST /v1/partner-webhooks'))
text('Exige webhooks:manage. Guarde endpoint.id e signingSecret retornados. O segredo HMAC é separado da API key e não aparece nas listagens. HTTPS público, porta 443, DNS/certificado válidos, sem query, fragmento ou credenciais; até cinco endpoints ativos por tenant.')
table(['Evento', 'Conteúdo observado'], [
    ['message.received', 'Mensagem recebida.'], ['message.created', 'Registro de saída, inclusive origem observada.'],
    ['message.status', 'Estado de mensagem.'], ['connection.status', 'Estado de conexão QR ou Meta.'],
], [54 * mm, 120 * mm])
h('Verificar assinatura e confirmar recebimento')
code('X-JRC-Event-Id: UUID_DO_EVENTO\nX-JRC-Timestamp: UNIX_SEGUNDOS\nX-JRC-Signature: sha256=HEX_HMAC\n\nHEX_HMAC = HMAC_SHA256(signingSecret,\n  timestamp + "." + eventId + "." + exactRawBody)')
text('Valide os bytes brutos antes do JSON, assinatura em tempo constante, eventId do header contra o envelope e timestamp em janela de cinco minutos. Persista eventId único antes do 2xx. Entrega ao menos uma vez e possivelmente fora de ordem: deduplique e preserve a origem para evitar loop de reenvio.')
text('Até dez tentativas totais. Rede, 5xx, 408, 425 e 429 permitem retry limitado; outros códigos, incluindo redirect, são terminais. DELIVERED em uma entrega HTTP significa 2xx do receptor, não entrega no WhatsApp.')
h('GET - polling e diagnóstico')
code('GET /v1/partner-events?after=0&limit=50\nGET /v1/partner-events?after=CURSOR_RETORNADO&limit=50\nGET /v1/partner-webhook-deliveries?limit=50')
text('Persista nextCursor como string decimal; não converta para Number no JavaScript. Retenção: 30 dias. 409 EVENT_CURSOR_EXPIRED fornece resetCursor/earliestCursor/lastPrunedCursor; reinicie e concilie com mensagens. Eventos históricos importados não são automaticamente novas mensagens acionáveis.')
h('DELETE - revogar receptor')
code('DELETE /v1/partner-webhooks/{id}\nX-JRC-API-Key: $BROKER_API_KEY')
text('Cancela entregas pendentes e remove o segredo; uma requisição já despachada pode chegar. Revogar API key não revoga automaticamente o receptor. O catálogo a seguir informa os parâmetros e códigos declarados de cada operação.')

page('Catálogo | conexões QR')
text('Rotas e códigos extraídos do contrato público. {id} e demais parâmetros de caminho são obrigatórios; UUIDs do Broker, salvo IDs numéricos explicitamente descritos no controle Chatwoot. Nos exemplos JSON, UUIDs são sintéticos. Os schemas completos no Swagger definem tipos, limites e campos de resposta.', 'Small')
catalog(keys_for('instances'))
text('Criar uma instância não concede controle Chatwoot. /connect também serve à reconexão; não existe /reconnect neste catálogo. Resultado pending/operationId exige acompanhamento. QR exibido, HTTP de sucesso e container saudável não comprovam entrega.', 'Small')
text('PDF, Swagger e imagens devem corresponder à mesma revisão. Código e documentação locais não comprovam implantação, migration aplicada ou mídia entregue/reproduzida em provider/host. Valide esses resultados no ambiente autorizado.', 'Small')

page('Catálogo | mensageria e arquivos')
catalog(keys_for('messaging'))

page('Catálogo | eventos e erros')
catalog(keys_for('events'))
h('Tratamento de falhas e resultados incertos')
table(['HTTP / estado', 'Ação do cliente'], [
    ['400 / 422', 'Corrigir parâmetros/corpo conforme schema.'], ['401 / 403', 'Conferir credencial única, validade, escopos e vínculo.'],
    ['404', 'Conferir recurso do tenant e disponibilidade do perfil.'], ['409', 'Conciliar revisão, identidade, idempotência ou cursor.'],
    ['429', 'Aplicar backoff, preservando a intenção idempotente.'],
    ['502 / 503 / timeout / UNKNOWN', 'Consultar a intenção existente. Não forçar reenvio com nova chave.'],
], [51 * mm, 123 * mm])
text('Falhas estruturadas usam application/problem+json com code e requestId quando declarado pela rota. Preserve requestId nos logs sem incluir chaves, segredos ou payloads de clientes. Operações legadas podem declarar somente sucesso. A ausência de evento não comprova falha ou sucesso.', 'Small')

control_keys = keys_for('chatwoot')
page('Catálogo | controle Chatwoot (1/2)')
text('Perfil opcional com chave de controle vinculada à Account autorizada, separado da chave genérica. X-JRC-External-Actor é atribuição auditável e não autentica o usuário remoto; campanhas exigem o ID numérico do administrador e revisões atuais. O backend consumidor revalida sua sessão e permissões locais.', 'Small')
catalog(control_keys[:8])

page('Catálogo | controle Chatwoot (2/2)')
catalog(control_keys[8:])
h('Identidade, agentes e campanhas')
text('PUT /agents define o conjunto de agentIds da Account vinculada. GET status nunca aprova identidade. Somente vínculo QR novo elegível e uma intenção administrativa válida permitem matrícula inicial; legado ou troca de número exigem confirm-identity com observedRevision atual e decisão explícita. Não confirme automaticamente após erro.', 'Small')
text('READY/SUCCEEDED comprovam configuração; CONNECTED observa sessão; OPERATIONAL exige identidade e evidências atuais. Uma reserva de campanha exige host compatível e callback canônico único; não duplique pelo envio genérico. Este perfil não publica Flow e não certifica instalação externa.', 'Small')
h('Versão e rastreabilidade')
text(str(len(OPERATIONS)) + ' operações. Edição ' + EDITION + '. Contrato SHA-256:', 'Small')
text(DATA['sourceHash'], 'Route')


def decorate(canvas, doc):
    canvas.setStrokeColor(colors.HexColor('#dbe5ef'))
    canvas.line(18 * mm, 281 * mm, 192 * mm, 281 * mm)
    canvas.setFillColor(NAVY)
    canvas.setFont('Helvetica-Bold', 8)
    canvas.drawString(18 * mm, 285 * mm, 'BROKER | API PÚBLICA')
    canvas.setFont('Helvetica', 8)
    canvas.drawString(18 * mm, 12 * mm, '29/10/2026 | Guia técnico - exemplos sintéticos')
    canvas.drawRightString(192 * mm, 12 * mm, str(doc.page))


OUT.parent.mkdir(parents=True, exist_ok=True)
SimpleDocTemplate(str(OUT), pagesize=(210 * mm, 297 * mm), rightMargin=18 * mm, leftMargin=18 * mm,
    topMargin=25 * mm, bottomMargin=20 * mm, title='Broker - Guia técnico da API pública', author='Broker',
    subject='Conexões QR, mensageria, mídia privada e eventos').build(story, onFirstPage=decorate, onLaterPages=decorate)
manifest = {**DATA['provenance'], 'pdfSha256': hashlib.sha256(OUT.read_bytes()).hexdigest(),
            'operationCount': len(OPERATIONS), 'edition': EDITION}
OUT.with_suffix('.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'pdf': str(OUT), 'bytes': OUT.stat().st_size, 'operations': len(OPERATIONS)}))
