import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CURRENT_AUDIT_PROFILE } from '../scripts/security/audit-profile.mjs';
import {
  buildAuditSourceReference,
  generateSecurityAudit,
} from '../scripts/security/generate-security-audit.mjs';
import { TEST_SECRET_CANARIES } from '../scripts/security/secret-canaries.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const EPOCH = CURRENT_AUDIT_PROFILE.sourceDateEpoch;
const FINGERPRINT_SECRET = 'reproducible-audit-fingerprint-test-key';
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function outputDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'jrc-audit-artifacts-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function digest(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

describe('artefatos reproduzíveis da auditoria de segurança', () => {
  it('mantém a referência de fonte ao versionar o próprio relatório', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jrc-audit-source-reference-'));
    temporaryDirectories.push(directory);
    await mkdir(resolve(directory, 'apps/api/src'), { recursive: true });
    await mkdir(resolve(directory, CURRENT_AUDIT_PROFILE.outputDirectory), { recursive: true });
    await writeFile(resolve(directory, 'apps/api/src/app.ts'), 'export const app = true;\n');
    execFileSync('git', ['init', '--quiet'], { cwd: directory });
    execFileSync('git', ['config', 'user.email', 'audit@example.test'], { cwd: directory });
    execFileSync('git', ['config', 'user.name', 'Audit Test'], { cwd: directory });
    execFileSync('git', ['add', '.'], { cwd: directory });
    execFileSync('git', ['commit', '--quiet', '-m', 'runtime'], { cwd: directory });

    const beforeReport = buildAuditSourceReference({ rootDirectory: directory });
    await writeFile(
      resolve(directory, CURRENT_AUDIT_PROFILE.outputDirectory, 'relatorio-auditoria-seguranca.md'),
      '# relatório\n',
    );
    execFileSync('git', ['add', '.'], { cwd: directory });
    execFileSync('git', ['commit', '--quiet', '-m', 'audit report'], { cwd: directory });
    const afterReportCommit = buildAuditSourceReference({ rootDirectory: directory });

    expect(afterReportCommit).toBe(beforeReport);
    await writeFile(resolve(directory, 'apps/api/src/app.ts'), 'export const app = false;\n');
    expect(buildAuditSourceReference({ rootDirectory: directory })).not.toBe(beforeReport);
  }, 15_000);

  it('gera duas vezes os mesmos JSON, Markdown, issues e PDF', async () => {
    const first = await outputDirectory();
    const second = await outputDirectory();
    await generateSecurityAudit({ rootDirectory: ROOT, outputDirectory: first, sourceDateEpoch: EPOCH, fingerprintSecret: FINGERPRINT_SECRET });
    await generateSecurityAudit({ rootDirectory: ROOT, outputDirectory: second, sourceDateEpoch: EPOCH, fingerprintSecret: FINGERPRINT_SECRET });

    for (const path of [
      'findings.json', 'route-inventory.json', 'secret-scan-summary.json',
      'relatorio-auditoria-seguranca.md', 'relatorio-auditoria-seguranca.pdf',
      'issues/001-jrc-sec-201.md', 'pdf-verification.json',
    ]) {
      expect(await digest(resolve(first, path)), path).toBe(await digest(resolve(second, path)));
    }
  }, 90_000);

  it('preserva o layout, a paleta e todas as seções obrigatórias', async () => {
    const directory = await outputDirectory();
    const result = await generateSecurityAudit({ rootDirectory: ROOT, outputDirectory: directory, sourceDateEpoch: EPOCH, fingerprintSecret: FINGERPRINT_SECRET });
    const markdown = await readFile(resolve(directory, 'relatorio-auditoria-seguranca.md'), 'utf8');
    const pdf = await readFile(resolve(directory, 'relatorio-auditoria-seguranca.pdf'));
    const verification = JSON.parse(await readFile(resolve(directory, 'pdf-verification.json'), 'utf8'));

    expect(markdown).toContain('# Relatório de Auditoria de Segurança — JRC WhatsApp Broker');
    expect(markdown).toContain('Incremento: 2 — Console web operacional JRC');
    expect(markdown).toMatch(/Referência da fonte: `sha256:[a-f0-9]{64}`/u);
    expect(markdown).not.toContain('- Commit:');
    for (const section of ['Resumo executivo', 'Escopo e nota metodológica', 'Distribuição por severidade', 'Pontos fortes', 'Pontos fracos', 'Tabela de achados', 'Prioridades', 'Inventário de rotas', 'Issues completas']) {
      expect(markdown).toContain(section);
    }
    expect(markdown).toContain('--- ISSUE 1 ---');
    expect(markdown).toContain('--- FIM ISSUE 1 ---');
    expect(verification).toMatchObject({
      pageCount: result.pageCount,
      chromePages: Array.from({ length: result.pageCount - 1 }, (_, index) => index + 2),
      minimumRasterDpi: 150,
      pageSize: 'A4',
      marginMillimeters: 18,
      headerFromPage: 2,
      palette: {
        CRITICAL: '#B91C1C', HIGH: '#EA580C', MEDIUM: '#D97706', LOW: '#2563EB',
        STRENGTH: '#059669', INFO: '#475569', BACKGROUND: '#F8FAFC',
      },
      headerText: 'JRC WhatsApp Broker | Auditoria de Segurança — Incremento 2',
    });
    expect(result.pageCount).toBeGreaterThanOrEqual(5);
    expect(pdf.toString('latin1').match(/\/Type \/Page\b/gu)).toHaveLength(result.pageCount);
    expect(pdf.toString('latin1')).toContain('/MediaBox [0 0 595.28 841.89]');
  }, 30_000);

  it('não inclui nenhum valor-canário nos artefatos e gera mesmo com finding HIGH aberto', async () => {
    const directory = await outputDirectory();
    const source = JSON.parse(await readFile(resolve(ROOT, 'docs/security/phase-1-increment-2/findings.json'), 'utf8'));
    source.findings.push({ ...source.findings[0], id: 'JRC-SEC-999', severity: 'HIGH', status: 'OPEN', title: 'Achado sintético aberto' });
    await generateSecurityAudit({ rootDirectory: ROOT, outputDirectory: directory, sourceDateEpoch: EPOCH, fingerprintSecret: FINGERPRINT_SECRET, auditData: source });

    const secondIssue = await readFile(resolve(directory, 'issues/002-jrc-sec-999.md'), 'utf8');
    expect(secondIssue).toContain('--- ISSUE 2 ---');
    expect(secondIssue).toContain('--- FIM ISSUE 2 ---');
    expect(secondIssue).not.toContain('--- ISSUE 1 ---');
    expect(secondIssue).not.toContain('--- FIM ISSUE 1 ---');

    for (const path of ['findings.json', 'secret-scan-summary.json', 'relatorio-auditoria-seguranca.md', 'relatorio-auditoria-seguranca.pdf']) {
      const content = await readFile(resolve(directory, path));
      for (const canary of Object.values(TEST_SECRET_CANARIES)) {
        expect(content.includes(Buffer.from(canary)), `${path} contém canário`).toBe(false);
      }
    }
  }, 30_000);

  it('não apresenta findings não aplicáveis como pontos fracos', async () => {
    const directory = await outputDirectory();
    const source = JSON.parse(await readFile(resolve(ROOT, 'docs/security/phase-1-increment-2/findings.json'), 'utf8'));
    source.findings.push({
      ...source.findings[0],
      id: 'JRC-SEC-299',
      title: 'Controle sintético não aplicável',
      status: 'NOT_APPLICABLE',
    });
    await generateSecurityAudit({ rootDirectory: ROOT, outputDirectory: directory, sourceDateEpoch: EPOCH, fingerprintSecret: FINGERPRINT_SECRET, auditData: source });
    const markdown = await readFile(resolve(directory, 'relatorio-auditoria-seguranca.md'), 'utf8');
    const weakSection = markdown.split('## Pontos fracos')[1].split('## Tabela de achados')[0];
    expect(weakSection).not.toContain('JRC-SEC-299');
  }, 30_000);
});
