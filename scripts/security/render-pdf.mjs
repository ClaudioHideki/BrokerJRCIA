import PDFDocument from 'pdfkit';

export const AUDIT_PALETTE = Object.freeze({
  CRITICAL: '#B91C1C',
  HIGH: '#EA580C',
  MEDIUM: '#D97706',
  LOW: '#2563EB',
  STRENGTH: '#059669',
  INFO: '#475569',
  BACKGROUND: '#F8FAFC',
});

const PAGE = Object.freeze({ width: 595.28, height: 841.89, margin: 51.024 });
const CONTENT_BOTTOM = PAGE.height - 66;
const PRIORITY = Object.freeze({ CRITICAL: 'P1', HIGH: 'P2', MEDIUM: 'P3', LOW: 'P4', INFO: 'P4' });

export async function renderAuditPdf({ auditData, routeInventory, sourceReference, referenceDate, scanSummary, profile }) {
  const input = { auditData, routeInventory, sourceReference, referenceDate, scanSummary, profile };
  const firstPass = await renderAuditPdfPass(input, null);
  const finalPass = await renderAuditPdfPass(input, firstPass.pageCount);
  if (finalPass.pageCount !== firstPass.pageCount) throw new Error('PDF pagination changed between rendering passes');
  return finalPass;
}

async function renderAuditPdfPass({ auditData, routeInventory, sourceReference, referenceDate, scanSummary, profile }, totalPages) {
  const fixedDate = new Date(`${referenceDate}T00:00:00.000Z`);
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: PAGE.margin, right: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin },
    bufferPages: true,
    compress: false,
    autoFirstPage: true,
    info: {
      Title: 'Relatório de Auditoria de Segurança — JRC WhatsApp Broker',
      Author: 'JRC',
      Subject: profile.subject,
      Creator: 'JRC Security Audit Generator',
      Producer: 'JRC Security Audit Generator',
      CreationDate: fixedDate,
      ModDate: fixedDate,
    },
  });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolvePromise, reject) => {
    doc.on('end', () => resolvePromise(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  drawCover(doc, { sourceReference, referenceDate, profile });
  addContentPage(doc);
  heading(doc, 'Resumo executivo', 1);
  paragraph(doc, `Foram consolidados ${auditData.findings.length} achado(s), ${auditData.strengths.length} ponto(s) forte(s) e ${routeInventory.length} rotas públicas. O gate bloqueia exclusivamente achados CRITICAL ou HIGH em estado OPEN.`);
  statCards(doc, auditData);

  heading(doc, 'Escopo e nota metodológica', 1);
  paragraph(doc, `Escopo: ${profile.scope}. Permanecem fora: ${profile.exclusions}.`);
  paragraph(doc, 'Método: evidência em código e linhas, testes automatizados, inventário derivado do OpenAPI e scanners com saída sanitizada. O submódulo Evolution não é varrido historicamente; seu pin e sua fronteira são validados separadamente.');
  paragraph(doc, 'Eixos obrigatórios: isolamento multitenant; autorização não dependente somente do frontend; IDOR; exposição de segredos; inputs inseguros/XSS. Todos são aplicáveis neste incremento.');
  paragraph(doc, 'Categorias: CRITICAL — comprometimento imediato (P1); HIGH — impacto grave (P2); MEDIUM — impacto relevante condicionado (P3); LOW — hardening ou impacto limitado (P4); STRENGTH — controle positivo comprovado, sem efeito bloqueante.');
  drawSeverityChips(doc);

  ensureSpace(doc, 235);
  heading(doc, 'Distribuição por severidade', 1);
  drawDonut(doc, auditData);
  drawCategoryBars(doc, auditData);

  heading(doc, 'Pontos fortes', 1);
  for (const strength of auditData.strengths) {
    card(doc, strength.id, strength.title, strength.description, AUDIT_PALETTE.STRENGTH);
  }

  ensureSpace(doc, 165);
  heading(doc, 'Pontos fracos', 1);
  const applicableFindings = auditData.findings.filter(({ status }) => status !== 'NOT_APPLICABLE');
  if (applicableFindings.length === 0) paragraph(doc, 'Nenhum ponto fraco aplicável.');
  for (const finding of applicableFindings) {
    card(doc, `${finding.id} · ${finding.severity}/${finding.status}`, finding.title, finding.description, AUDIT_PALETTE[finding.severity]);
  }

  ensureSpace(doc, 115);
  heading(doc, 'Tabela de achados', 1);
  findingTable(doc, auditData.findings);

  ensureSpace(doc, 80);
  heading(doc, 'Prioridades', 1);
  if (applicableFindings.length === 0) paragraph(doc, 'Nenhuma prioridade aplicável.');
  for (const finding of applicableFindings) {
    bullet(doc, `${PRIORITY[finding.severity]} · ${finding.id} — ${finding.title}`);
  }

  ensureSpace(doc, 115);
  heading(doc, 'Inventário de rotas', 1);
  for (const route of routeInventory) routeCard(doc, route);

  ensureSpace(doc, 100);
  heading(doc, 'Varredura sanitizada de segredos', 1);
  for (const scan of scanSummary.scans) {
    bullet(doc, `${scan.scanner}: ${scan.findingCount} ocorrência(s); escopo ${scan.scope.join(', ')}; exclusões ${scan.excluded.join(', ') || 'nenhuma'}.`);
  }

  ensureSpace(doc, 160);
  heading(doc, 'Issues completas', 1);
  for (const [index, finding] of auditData.findings.entries()) {
    ensureSpace(doc, 110);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(AUDIT_PALETTE.INFO)
      .text(`--- ISSUE ${index + 1} ---`);
    doc.moveDown(0.35);
    issueText(doc, finding.issueMarkdown
      .replace(`--- ISSUE ${index + 1} ---`, '')
      .replace(`--- FIM ISSUE ${index + 1} ---`, '')
      .trim());
    ensureSpace(doc, 24);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(AUDIT_PALETTE.INFO)
      .text(`--- FIM ISSUE ${index + 1} ---`);
    doc.moveDown(0.8);
  }

  const range = doc.bufferedPageRange();
  const effectiveTotalPages = totalPages ?? range.count;
  const chromePages = [];
  for (let pageIndex = 1; pageIndex < range.count; pageIndex += 1) {
    doc.switchToPage(range.start + pageIndex);
    drawRunningChrome(doc, pageIndex + 1, effectiveTotalPages, profile.headerText);
    chromePages.push(pageIndex + 1);
  }
  doc.end();
  return { buffer: await done, pageCount: range.count, chromePages };
}

function drawCover(doc, { sourceReference, referenceDate, profile }) {
  doc.rect(0, 0, PAGE.width, PAGE.height).fill(AUDIT_PALETTE.BACKGROUND);
  doc.rect(0, 0, 18, PAGE.height).fill(AUDIT_PALETTE.INFO);
  doc.circle(485, 110, 48).fill(AUDIT_PALETTE.STRENGTH);
  doc.circle(485, 110, 27).fill(AUDIT_PALETTE.BACKGROUND);
  doc.fillColor(AUDIT_PALETTE.INFO).font('Helvetica-Bold').fontSize(13)
    .text('JRC WHATSAPP BROKER', 62, 90, { characterSpacing: 1.1 });
  doc.fontSize(28).fillColor('#0F172A')
    .text('Relatório de Auditoria de Segurança — JRC WhatsApp Broker', 62, 230, { width: 450, lineGap: 6 });
  doc.moveTo(62, 390).lineTo(530, 390).lineWidth(2).strokeColor(AUDIT_PALETTE.STRENGTH).stroke();
  doc.fontSize(11).fillColor('#334155')
    .text(`Fase ${profile.phase}`, 62, 430)
    .text(`Incremento ${profile.increment} — ${profile.incrementTitle}`, 62, 452)
    .text('Referência da fonte', 62, 474);
  doc.font('Courier').fontSize(7.5).fillColor('#334155')
    .text(sourceReference, 62, 491, { width: 468, lineBreak: false });
  doc.font('Helvetica').fontSize(11).fillColor('#334155')
    .text(`Data de referência ${referenceDate}`, 62, 510);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(AUDIT_PALETTE.STRENGTH)
    .text('DOCUMENTO DE CONTROLE E EVIDÊNCIA', 62, 690);
}

function addContentPage(doc) {
  doc.addPage({ size: 'A4', margins: { top: PAGE.margin, right: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin } });
  // Page breaks are controlled by ensureSpace so headers and footers are never
  // bypassed by PDFKit's implicit pagination. The visual 18 mm boundary is
  // enforced by CONTENT_BOTTOM rather than the flow engine.
  doc.page.margins.bottom = 0;
  doc.x = PAGE.margin;
  doc.y = 76;
}

function ensureSpace(doc, required) {
  if (doc.y + required <= CONTENT_BOTTOM) return;
  addContentPage(doc);
}

function heading(doc, text, level = 1) {
  ensureSpace(doc, level === 1 ? 55 : 38);
  doc.x = PAGE.margin;
  doc.font('Helvetica-Bold').fontSize(level === 1 ? 18 : 13).fillColor('#0F172A')
    .text(text, PAGE.margin, doc.y, { width: PAGE.width - PAGE.margin * 2, keepTogether: true });
  doc.moveDown(level === 1 ? 0.55 : 0.35);
}

function paragraph(doc, text) {
  ensureSpace(doc, 55);
  doc.x = PAGE.margin;
  doc.font('Helvetica').fontSize(9.5).fillColor('#334155')
    .text(text, PAGE.margin, doc.y, { width: PAGE.width - PAGE.margin * 2, lineGap: 2.5, align: 'left' });
  doc.moveDown(0.75);
}

function bullet(doc, text) {
  ensureSpace(doc, 30);
  doc.x = PAGE.margin;
  doc.font('Helvetica').fontSize(9).fillColor('#334155')
    .text(`-  ${text}`, PAGE.margin, doc.y, { width: PAGE.width - PAGE.margin * 2, indent: 8, lineGap: 2 });
  doc.moveDown(0.35);
}

function statCards(doc, auditData) {
  ensureSpace(doc, 82);
  const cards = [
    ['Achados', auditData.findings.length, AUDIT_PALETTE.INFO],
    ['Bloqueantes', auditData.findings.filter((item) => item.status === 'OPEN' && ['CRITICAL', 'HIGH'].includes(item.severity)).length, AUDIT_PALETTE.CRITICAL],
    ['Pontos fortes', auditData.strengths.length, AUDIT_PALETTE.STRENGTH],
  ];
  const y = doc.y;
  cards.forEach(([label, value, color], index) => {
    const x = PAGE.margin + index * 164;
    doc.roundedRect(x, y, 148, 62, 6).fillAndStroke('#FFFFFF', '#E2E8F0');
    doc.font('Helvetica-Bold').fontSize(22).fillColor(color).text(String(value), x + 12, y + 10, { width: 124 });
    doc.font('Helvetica').fontSize(8.5).fillColor('#475569').text(label, x + 12, y + 39, { width: 124 });
  });
  doc.x = PAGE.margin;
  doc.y = y + 78;
}

function drawSeverityChips(doc) {
  ensureSpace(doc, 48);
  let x = PAGE.margin;
  const y = doc.y;
  for (const key of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'STRENGTH']) {
    const width = key === 'STRENGTH' ? 84 : 78;
    doc.roundedRect(x, y, width, 22, 11).fill(AUDIT_PALETTE[key]);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#FFFFFF').text(key, x, y + 7, { width, align: 'center' });
    x += width + 7;
  }
  doc.x = PAGE.margin;
  doc.y = y + 38;
}

function drawDonut(doc, auditData) {
  ensureSpace(doc, 180);
  const counts = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((severity) => auditData.findings.filter((finding) => finding.severity === severity).length);
  const total = counts.reduce((sum, value) => sum + value, 0);
  const y = doc.y;
  const centerX = PAGE.margin + 70;
  const centerY = y + 70;
  const radius = 50;
  doc.circle(centerX, centerY, radius).lineWidth(18).strokeColor('#E2E8F0').stroke();
  if (total > 0) {
    let startAngle = -Math.PI / 2;
    counts.forEach((count, index) => {
      if (count === 0) return;
      const endAngle = startAngle + (count / total) * Math.PI * 2;
      drawArc(doc, centerX, centerY, radius, startAngle, Math.min(endAngle, startAngle + Math.PI * 2 - 0.001), AUDIT_PALETTE[['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'][index]]);
      startAngle = endAngle;
    });
  }
  doc.font('Helvetica').fontSize(24).fillColor('#0F172A')
    .text(String(total), PAGE.margin, y + 47, { width: 140, align: 'center', lineBreak: false });
  doc.font('Helvetica').fontSize(8).fillColor('#475569')
    .text('ACHADOS C/H/M/L', PAGE.margin, y + 78, { width: 140, align: 'center', lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0F172A').text('Rosca por severidade', PAGE.margin + 170, y + 12, { width: 300 });
  doc.font('Helvetica').fontSize(9).fillColor('#475569').text('A rosca exclui INFO, reservado a contexto e não aplicabilidade. Ausência de segmentos indica zero achados CRITICAL, HIGH, MEDIUM ou LOW.', PAGE.margin + 170, y + 37, { width: 300, lineGap: 3 });
  doc.x = PAGE.margin;
  doc.y = y + 155;
}

function drawArc(doc, centerX, centerY, radius, startAngle, endAngle, color) {
  const startX = centerX + radius * Math.cos(startAngle);
  const startY = centerY + radius * Math.sin(startAngle);
  const endX = centerX + radius * Math.cos(endAngle);
  const endY = centerY + radius * Math.sin(endAngle);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  doc.path(`M ${startX} ${startY} A ${radius} ${radius} 0 ${largeArc} 1 ${endX} ${endY}`)
    .lineWidth(18)
    .lineCap('butt')
    .strokeColor(color)
    .stroke();
}

function drawCategoryBars(doc, auditData) {
  ensureSpace(doc, 205);
  heading(doc, 'Evidências por categoria', 2);
  const categories = new Map();
  for (const item of [...auditData.findings, ...auditData.strengths]) categories.set(item.category, (categories.get(item.category) ?? 0) + 1);
  for (const [category, count] of [...categories.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    ensureSpace(doc, 24);
    const y = doc.y;
    doc.font('Helvetica').fontSize(7.5).fillColor('#334155').text(category, PAGE.margin, y + 3, { width: 170 });
    doc.roundedRect(PAGE.margin + 175, y, 250, 12, 4).fill('#E2E8F0');
    doc.roundedRect(PAGE.margin + 175, y, Math.max(18, Math.min(250, count * 34)), 12, 4).fill(AUDIT_PALETTE.STRENGTH);
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#334155').text(String(count), PAGE.margin + 435, y + 2, { width: 25, align: 'right' });
    doc.y = y + 20;
  }
  doc.x = PAGE.margin;
  doc.moveDown(0.5);
}

function card(doc, label, title, description, color) {
  const width = PAGE.width - PAGE.margin * 2;
  const descriptionHeight = doc.heightOfString(description, { width: width - 30, lineGap: 2 });
  const height = 49 + descriptionHeight;
  ensureSpace(doc, height + 12);
  const y = doc.y;
  doc.roundedRect(PAGE.margin, y, width, height, 5).fillAndStroke('#FFFFFF', '#E2E8F0');
  doc.rect(PAGE.margin, y, 5, height).fill(color);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(color).text(label, PAGE.margin + 15, y + 10, { width: width - 30 });
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#0F172A').text(title, PAGE.margin + 15, y + 25, { width: width - 30 });
  doc.font('Helvetica').fontSize(8.5).fillColor('#475569').text(description, PAGE.margin + 15, y + 42, { width: width - 30, lineGap: 2 });
  doc.x = PAGE.margin;
  doc.y = y + height + 10;
}

function findingTable(doc, findings) {
  const rows = findings.length === 0 ? [['—', 'Nenhum achado', '—', '—', '—']] : findings.map((finding) => [finding.id, finding.category, finding.severity, finding.status, `${finding.file}:${finding.lineStart}-${finding.lineEnd}`]);
  const widths = [62, 115, 60, 75, 181];
  const headers = ['ID', 'Categoria', 'Severidade', 'Estado', 'Arquivo/linhas'];
  tableRow(doc, headers, widths, true);
  rows.forEach((row) => tableRow(doc, row, widths, false));
  doc.moveDown(0.8);
}

function tableRow(doc, values, widths, header) {
  const height = Math.max(28, ...values.map((value, index) => doc.heightOfString(String(value), { width: widths[index] - 10 }) + 12));
  ensureSpace(doc, height);
  let x = PAGE.margin;
  const y = doc.y;
  values.forEach((value, index) => {
    doc.rect(x, y, widths[index], height).fillAndStroke(header ? '#E2E8F0' : '#FFFFFF', '#CBD5E1');
    doc.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(header ? 7.5 : 7).fillColor('#334155')
      .text(String(value), x + 5, y + 6, { width: widths[index] - 10, height: height - 10 });
    x += widths[index];
  });
  doc.x = PAGE.margin;
  doc.y = y + height;
}

function routeCard(doc, route) {
  ensureSpace(doc, 52);
  const y = doc.y;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(AUDIT_PALETTE.LOW)
    .text(`${route.method} ${route.path}`, PAGE.margin, y, { width: 220 });
  doc.font('Helvetica').fontSize(7.4).fillColor('#475569')
    .text(`${route.authentication} · ${route.permission} · RLS ${route.tenantRls ? 'SIM' : 'NÃO'}`, PAGE.margin + 225, y + 1, { width: 268, align: 'right' });
  doc.fontSize(7.5).text(`Ownership: ${route.ownershipCheck}`, PAGE.margin, y + 17, { width: 493 });
  doc.text(`Handler: ${route.handlerFile}:${route.handlerLine}`, PAGE.margin, y + 30, { width: 493 });
  doc.moveTo(PAGE.margin, y + 45).lineTo(PAGE.width - PAGE.margin, y + 45).strokeColor('#E2E8F0').stroke();
  doc.x = PAGE.margin;
  doc.y = y + 52;
}

function issueText(doc, text) {
  const normalized = text.replace(/^#{1,3}\s+/gmu, '').replace(/^[-*]\s+/gmu, '- ');
  for (const block of normalized.split(/\n\s*\n/u)) {
    ensureSpace(doc, Math.min(90, doc.heightOfString(block, { width: 493, lineGap: 2 }) + 16));
    const isHeading = !block.includes('\n') && block.length < 90;
    doc.x = PAGE.margin;
    doc.font(isHeading ? 'Helvetica-Bold' : 'Helvetica').fontSize(isHeading ? 10 : 8.3).fillColor(isHeading ? '#0F172A' : '#334155')
      .text(block, PAGE.margin, doc.y, { width: PAGE.width - PAGE.margin * 2, lineGap: 2 });
    doc.moveDown(0.45);
  }
}

function drawRunningChrome(doc, pageNumber, pageCount, headerText) {
  doc.save();
  const bottomMargin = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  const header = headerText;
  doc.font('Helvetica').fontSize(7.5).fillColor(AUDIT_PALETTE.INFO)
    .text(header, PAGE.margin, 29, { lineBreak: false });
  doc.moveTo(PAGE.margin, 43).lineTo(PAGE.width - PAGE.margin, 43).lineWidth(0.6).strokeColor('#CBD5E1').stroke();
  doc.moveTo(PAGE.margin, PAGE.height - 43).lineTo(PAGE.width - PAGE.margin, PAGE.height - 43).stroke();
  if (pageCount !== null) {
    const footer = `Página ${pageNumber} de ${pageCount}`;
    const footerWidth = doc.widthOfString(footer);
    doc.text(footer, PAGE.width - PAGE.margin - footerWidth, PAGE.height - 34, { lineBreak: false });
  }
  doc.page.margins.bottom = bottomMargin;
  doc.restore();
}
