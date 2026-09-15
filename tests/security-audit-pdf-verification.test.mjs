import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateSecurityAudit } from '../scripts/security/generate-security-audit.mjs';
import { CURRENT_AUDIT_PROFILE } from '../scripts/security/audit-profile.mjs';
import {
  classifyVisibleChrome,
  unexpectedPdfDiagnostics,
  verifySecurityAuditPdf,
} from '../scripts/security/verify-pdf-artifact.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('verificação rasterizada do PDF de auditoria', () => {
  it('ignora somente os dois avisos ambientais conhecidos do Poppler', () => {
    expect(unexpectedPdfDiagnostics([
      "Syntax Error: No display font for 'Symbol'",
      "Syntax Error: No display font for 'ArialUnicode'",
    ].join('\n'))).toEqual([]);
    expect(unexpectedPdfDiagnostics('Syntax Error: damaged xref table'))
      .toEqual(['Syntax Error: damaged xref table']);
  });

  it('não aceita regiões uniformes e vazias como chrome visível', () => {
    expect(() => classifyVisibleChrome([{
      page: 2,
      header: 0,
      headerFingerprint: 'blank',
      footer: 0,
    }], [2])).toThrow(/empty.*header|header.*empty/iu);
  });

  it('confere páginas, rasters, cabeçalhos e paginação do arquivo real', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'jrc-audit-pdf-output-'));
    temporaryDirectories.push(outputDirectory);
    const generated = await generateSecurityAudit({
      rootDirectory: ROOT,
      outputDirectory,
      sourceDateEpoch: CURRENT_AUDIT_PROFILE.sourceDateEpoch,
      fingerprintSecret: 'audit-fingerprint-secret-for-pdf-test',
    });

    const result = await verifySecurityAuditPdf({
      pdfPath: resolve(outputDirectory, 'relatorio-auditoria-seguranca.pdf'),
      expectedPageCount: generated.pageCount,
      dpi: 150,
    });

    expect(result).toEqual({
      pageCount: generated.pageCount,
      rasterizedPageCount: generated.pageCount,
      headerPages: Array.from({ length: generated.pageCount - 1 }, (_, index) => index + 2),
      footerPages: Array.from({ length: generated.pageCount - 1 }, (_, index) => index + 2),
      dpi: 150,
    });
  }, 30_000);
});
