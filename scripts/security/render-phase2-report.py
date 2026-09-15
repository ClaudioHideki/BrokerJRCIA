"""Rebuild the phase-2 report from reviewed validation.json and current source anchors.

Requires reportlab. Run from the repository root. No network or secret input is used.
"""
import hashlib
import json
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs/security/phase-2-increment-1"
data = json.loads((OUT / "validation.json").read_text(encoding="utf-8-sig"))
anchors = [
    ("apps/api/src/modules/platform/service.ts", "export class PlatformService", "Administração dedicada, MFA e suporte auditado"),
    ("apps/api/drizzle/migrations/0011_tenant_operational_limits.sql", "CREATE TABLE organization_limits", "Limites e admissão transacional por empresa"),
    ("apps/api/src/modules/meta-onboarding/service.ts", "export function createMetaOnboardingService", "Autorização Meta do aplicativo JRC"),
    ("apps/web/src/pages/Platform.tsx", "export function PlatformPage", "Interface administrativa separada do portal"),
    ("infra/dokploy/compose.yaml", "services:", "Serviços Docker e fronteiras de credenciais"),
    ("packages/providers/src/meta/cloud-client.ts", "export class MetaCloudClient", "Transporte Meta limitado e sem retry cego"),
    ("packages/providers/src/meta/webhook.ts", "export function verifyMetaWebhookSignature", "Assinatura dos bytes originais"),
    ("packages/providers/src/typebot/client.ts", "export class TypebotClient", "Conector Typebot com validação de destino"),
    ("apps/api/src/modules/messaging/credentials.ts", "export function createTypebotClientResolver", "Credenciais Typebot limitadas por organização"),
    ("apps/api/src/modules/messaging/repository.ts", "async claimOutgoing", "Claim durável e política de envio"),
    ("apps/api/src/modules/messaging/repository.ts", "async completeBotTurn", "Sessão e respostas atômicas"),
    ("apps/api/src/http/routes/messaging.ts", "export async function registerMessagingRoutes", "RBAC e rotas JRC"),
    ("apps/api/src/modules/messaging/membership.ts", "export function createMessagingMembershipResolver", "Membership atual, usuário e organização ativos"),
    ("apps/api/src/modules/messaging/worker.ts", "export function createMessagingWorker", "Execução fora da transação"),
    ("apps/api/drizzle/migrations/0009_messaging_storage.sql", "CREATE TABLE messaging_channels", "Persistência, chaves compostas e RLS"),
    ("apps/web/tests/e2e/messaging.spec.ts", "test('Meta e Typebot", "Percurso de navegador com doubles"),
]
evidence = []
for relative, needle, description in anchors:
    source = (ROOT / relative).read_text(encoding="utf-8-sig")
    lines = source.splitlines()
    match = next((i + 1 for i, line in enumerate(lines) if needle in line), None)
    if match is None:
        raise ValueError(f"Evidence anchor missing: {relative}: {needle}")
    evidence.append({"file": relative, "line": match, "description": description,
                     "sha256": hashlib.sha256((ROOT / relative).read_bytes()).hexdigest()})
(OUT / "source-evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

sections = [
    ("Estado da entrega", "Incremento local Meta/Typebot ampliado para operação SaaS multitenant, administração JRC e preparação Dokploy/GHCR. Recursos implementados e testes locais não equivalem a homologação externa. Não foi realizado App Review, envio real ou publicação."),
    ("Base e escopo", f"Branch: {data['branch']}. Commit-base: {data['baseCommit']}. Console restaurada do ZIP fornecido e integrada à base Git. Evolution preservada no commit fixado; Ligo utilizada apenas como referência de produto. Arquivos restaurados não são apresentados como novos recursos escritos nesta fase."),
    ("Funcionalidades", "Meta texto/template e webhook assinado; inbox/outbox, idempotência, consentimento, Typebot e pausa humana. Contexto administrativo separado com senha/TOTP, empresas, responsáveis/usuários, planos/limites e suporte auditado. RLS e quotas no backend/worker. Embedded Signup, registro e verificação de pendências Meta; tokens criptografados. Portal, administração e infraestrutura de imagens/Compose documentados."),
    ("Limites dos testes", "PostgreSQL, Redis, autenticação, API e processamento são reais nos testes integrados. Meta, Typebot e conexão Baileys utilizam doubles. O E2E demonstra o percurso local e não comprova entrega externa, aprovação da Meta ou funcionamento de blocos de IA de um fluxo real."),
    ("Correções de revisão", "Corrigidos isolamento das credenciais Typebot, membership atual e RBAC, SQL e FK por canal, preservação do consentimento, ordem das respostas, lote de leases e falha determinada versus UNKNOWN. Pausa humana cancela automações ainda não iniciadas; preflight rejeitado finaliza claims corretamente; advisory locks serializam status e vínculo do ID Meta. Descadastro após enqueue/claim também impede texto automático. Vitest atualizado para 4.1.11 por GHSA-82fw-gwwq-j7x9, sem reduzir asserções."),
    ("Revisão SaaS", "Revisão independente identificou atualização de usuário no limite do plano, dados de interface após troca de tenant, revogação Meta durante preparação de envio e rota raiz do servidor web. As correções e regressões correspondentes estão incluídas na validação final. Ações externas já em voo não são desfeitas por uma suspensão posterior."),
    ("Pendências funcionais", "Coexistence, importação CSV/listas, gestão visual completa de consentimento, campanhas/agendamento/cancelamento, criação/aprovação de templates, mídia, webhooks JRC de saída e reconciliação visual UNKNOWN permanecem fora do incremento. O editor Typebot continua externo. Não existe upload de arquivos de clientes neste incremento."),
    ("Pendências externas e operação", "Configurar aplicativo JRC, Embedded Signup, permissões/aprovação Meta, ativos autorizados, pagamento e domínio HTTPS. Homologar o fluxo real e a versão Graph escolhida; os testes usam doubles. Preparar credenciais do registry, ambiente protegido de publicação e segredos Dokploy. Backup/restauração/retenção/exclusão têm runbook; rotinas agendadas e RPO/RTO dependem do servidor e de ensaio operacional."),
    ("Licenciamento", "Conector Typebot por API com edição externa. Não foi incorporado o editor. Avaliar separadamente versão específica convertida para Apache 2.0, editor/runtime próprios ou autorização comercial. A licença atual consultada é FSL-1.1-Apache-2.0; iframe não altera os requisitos de licença."),
    ("Acesso e reprodução", "Guias: docs/operations/dokploy-saas.md, saas-admin.md, saas-enforcement.md, saas-meta.md e meta-typebot.md. Desenvolvimento: http://127.0.0.1:5173/jrc (equipe) e /login (cliente); no Dokploy, domínio aponta ao web:8080. Os testes não deixam servidor permanente. Recriar relatório: python scripts/security/render-phase2-report.py. validation.json contém resultados observados, não novos testes executados pelo gerador."),
    ("Limites de autorização", "Nenhum commit, push, PR, merge, deploy, mensagem real ou alteração em produção foi realizado. Artefatos históricos preservados. Esta revisão cobre o incremento descrito e não afirma ausência geral de vulnerabilidades."),
]
md = ["# JRC WhatsApp Broker — fase 2, incremento 1", "", f"Data da execução: {data['date']}", ""]
for title, body in sections[:4]:
    md.extend([f"## {title}", "", body, ""])
md.extend(["## Validação observada", "", "| Verificação | Resultado |", "|---|---|"])
for item in data["checks"]:
    md.append(f"| {item['command']} | {item['result']} |")
for title, body in sections[4:]:
    md.extend(["", f"## {title}", "", body])
md.extend(["", "## Evidências de código", ""])
for item in evidence:
    md.append(f"- {item['description']}: {item['file']}:{item['line']}")
(OUT / "relatorio.md").write_text("\n".join(md) + "\n", encoding="utf-8")

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="JRCBody", fontName="Helvetica", fontSize=9, leading=13, spaceAfter=8, alignment=TA_LEFT))
styles['Title'].textColor = colors.HexColor('#007392')
styles['Heading2'].textColor = colors.HexColor('#153243')
story = [Paragraph("JRC WhatsApp Broker", styles['Title']), Paragraph("Fase 2 | Meta, Typebot e operação SaaS", styles['Heading2']), Paragraph(f"Execução: {escape(data['date'])}", styles['JRCBody'])]
for title, body in sections[:4]:
    story.extend([Paragraph(title, styles['Heading2']), Paragraph(escape(body), styles['JRCBody'])])
story.append(Paragraph("Validação observada", styles['Heading2']))
rows = [[Paragraph("Verificação", styles['JRCBody']), Paragraph("Resultado", styles['JRCBody'])]]
rows += [[Paragraph(escape(item['command']), styles['JRCBody']), Paragraph(escape(item['result']), styles['JRCBody'])] for item in data['checks']]
table = Table(rows, colWidths=[230, 281], repeatRows=1)
table.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#E9F4F7')), ('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LINEBELOW', (0, 0), (-1, 0), 0.8, colors.HexColor('#007392')), ('BOTTOMPADDING', (0, 0), (-1, -1), 5)]))
story.extend([table, Spacer(1, 10)])
for title, body in sections[4:]:
    story.extend([Paragraph(title, styles['Heading2']), Paragraph(escape(body), styles['JRCBody'])])
story.append(Paragraph("Evidências de código", styles['Heading2']))
for item in evidence:
    story.append(Paragraph(escape(f"{item['description']}: {item['file']}:{item['line']}"), styles['JRCBody']))

def footer(canvas, document):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor('#007392'))
    canvas.line(42, 36, 553, 36)
    canvas.setFont('Helvetica', 8)
    canvas.drawString(42, 24, 'JRC | Validação local; homologação externa pendente')
    canvas.drawRightString(553, 24, str(document.page))
    canvas.restoreState()

document = SimpleDocTemplate(str(OUT / "relatorio.pdf"), pagesize=(595.28, 841.89),
    leftMargin=42, rightMargin=42, topMargin=38, bottomMargin=50,
    title="JRC WhatsApp Broker - Fase 2 incremento 1", author="JRC", invariant=1)
document.build(story, onFirstPage=footer, onLaterPages=footer)
print(OUT / "relatorio.pdf")
