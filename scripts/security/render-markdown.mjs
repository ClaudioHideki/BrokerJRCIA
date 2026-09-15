const PRIORITY = Object.freeze({ CRITICAL: 'P1', HIGH: 'P2', MEDIUM: 'P3', LOW: 'P4', INFO: 'P4' });

export function renderAuditMarkdown({ auditData, routeInventory, sourceReference, referenceDate, scanSummary, profile }) {
  const applicableFindings = auditData.findings.filter(({ status }) => status !== 'NOT_APPLICABLE');
  const severityCounts = Object.fromEntries(
    ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].map((severity) => [
      severity,
      auditData.findings.filter((finding) => finding.severity === severity).length,
    ]),
  );
  const lines = [
    '# Relatório de Auditoria de Segurança — JRC WhatsApp Broker',
    '',
    `- Fase: ${profile.phase}`,
    `- Incremento: ${profile.increment} — ${profile.incrementTitle}`,
    `- Referência da fonte: \`${sourceReference}\``,
    `- Data de referência: ${referenceDate}`,
    '',
    '## Resumo executivo',
    '',
    `A auditoria registrou ${auditData.findings.length} achado(s) e ${auditData.strengths.length} ponto(s) forte(s). `
      + 'Somente achados CRITICAL ou HIGH com estado OPEN bloqueiam a entrega.',
    '',
    '## Escopo e nota metodológica',
    '',
    `O escopo cobre ${profile.scope}. Permanecem fora: ${profile.exclusions}.`,
    '',
    'As cinco categorias de apresentação são:',
    '',
    '- CRITICAL: comprometimento amplo ou imediato (P1).',
    '- HIGH: impacto grave e explorável (P2).',
    '- MEDIUM: impacto relevante sob condições adicionais (P3).',
    '- LOW: hardening ou impacto limitado (P4).',
    '- STRENGTH: controle positivo comprovado, sem efeito bloqueante.',
    '',
    'A evidência combina revisão estática, inventário derivado do OpenAPI, testes automatizados, varredura sanitizada do histórico Git JRC e bundles compilados. INFO é contexto, não uma sexta categoria de achado. O submódulo Evolution é excluído da varredura histórica e validado apenas por pin, origem e fronteira.',
    '',
    'Os cinco eixos obrigatórios são isolamento multitenant, autorização não dependente somente do frontend, IDOR, exposição de segredos e inputs inseguros/XSS. Todos são aplicáveis neste incremento e possuem conclusão rastreável.',
    '',
    '## Distribuição por severidade',
    '',
    '| CRITICAL | HIGH | MEDIUM | LOW | INFO | STRENGTH |',
    '| ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${severityCounts.CRITICAL} | ${severityCounts.HIGH} | ${severityCounts.MEDIUM} | ${severityCounts.LOW} | ${severityCounts.INFO} | ${auditData.strengths.length} |`,
    '',
    'O PDF apresenta esta distribuição em uma rosca e as evidências por categoria em barras horizontais.',
    '',
    '## Pontos fortes',
    '',
    ...auditData.strengths.flatMap((strength) => [
      `### ${strength.id} — ${strength.title}`,
      '',
      `${strength.description} Evidência: \`${strength.file}:${strength.lineStart}-${strength.lineEnd}\`.`,
      '',
    ]),
    '## Pontos fracos',
    '',
    ...(applicableFindings.length === 0
      ? ['Nenhum ponto fraco aplicável.', '']
      : applicableFindings.flatMap((finding) => [
        `- **${finding.id} [${finding.severity}/${finding.status}]** — ${finding.title}`,
      ])),
    '',
    '## Tabela de achados',
    '',
    '| ID | Categoria | Severidade | Estado | Arquivo | Linhas |',
    '| --- | --- | --- | --- | --- | ---: |',
    ...auditData.findings.map((finding) => (
      `| ${finding.id} | ${finding.category} | ${finding.severity} | ${finding.status} | \`${finding.file}\` | ${finding.lineStart}–${finding.lineEnd} |`
    )),
    '',
    '## Prioridades',
    '',
    ...(applicableFindings.length === 0
      ? ['Nenhuma prioridade aplicável.']
      : applicableFindings.map((finding) => `- ${PRIORITY[finding.severity]} — ${finding.id}: ${finding.title}`)),
    '',
    '## Inventário de rotas',
    '',
    '| Método | Rota | Autenticação | Permissão | Tenant/RLS | Ownership | Handler |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...routeInventory.map((route) => (
      `| ${route.method} | \`${route.path}\` | ${route.authentication} | ${route.permission} | ${route.tenantRls ? 'SIM' : 'NÃO'} | ${route.ownershipCheck} | \`${route.handlerFile}:${route.handlerLine}\` |`
    )),
    '',
    '## Varredura sanitizada de segredos',
    '',
    ...scanSummary.scans.map((scan) => `- ${scan.scanner}: ${scan.findingCount} ocorrência(s); exclusões: ${scan.excluded.join(', ') || 'nenhuma'}.`),
    '',
    '## Issues completas',
    '',
    ...auditData.findings.flatMap((finding) => [finding.issueMarkdown, '']),
  ];
  return `${lines.join('\n').trim()}\n`;
}
