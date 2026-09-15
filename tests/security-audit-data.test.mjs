import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AUDIT_CATEGORIES,
  assertAuditData,
  assertAuditEvidenceLocations,
  gateAuditData,
} from '../scripts/security/audit-schema.mjs';
import { buildRouteInventory } from '../scripts/security/inventory-routes.mjs';
import { CURRENT_AUDIT_PROFILE } from '../scripts/security/audit-profile.mjs';
import { TEST_SECRET_CANARIES } from '../scripts/security/secret-canaries.mjs';
import {
  scanCompiledBundle,
  scanForbiddenViteVariables,
} from '../scripts/security/scan-compiled-bundle.mjs';
import { scanJrcHistory } from '../scripts/security/scan-jrc-history.mjs';
import { hasDivergentNestedSubmodule } from '../scripts/security/check-submodule-clean.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const AUDIT_ROOT = resolve(ROOT, 'docs/security/phase-1-increment-2');
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

function openApiOperations(openapi) {
  return Object.entries(openapi.paths).flatMap(([path, item]) => (
    Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`)
  )).sort();
}

describe('dados reproduzíveis da auditoria de segurança', () => {
  it('mantém inventário completo e explícito para todas as rotas OpenAPI', async () => {
    const openapi = JSON.parse(await readFile(resolve(ROOT, 'docs/api/openapi.json'), 'utf8'));
    const stored = JSON.parse(await readFile(resolve(AUDIT_ROOT, 'route-inventory.json'), 'utf8'));
    const generated = await buildRouteInventory({ rootDirectory: ROOT, openapi });
    const historicKeys = new Set(stored.map(({ method, path }) => `${method} ${path}`));

    // The checked-in phase-1 report remains immutable while the live inventory
    // continues covering routes added by later phases.
    // Source locations move when later phases add imports/guards; policies remain immutable.
    // buildRouteInventory independently resolves and validates each current handler line.
    const withoutLocation = ({handlerLine, ...policy}) => policy;
    expect(generated.filter(({ method, path }) => historicKeys.has(`${method} ${path}`)).map(withoutLocation))
      .toEqual(stored.map(withoutLocation));
    expect(generated.map(({ method, path }) => `${method} ${path}`).sort())
      .toEqual(openApiOperations(openapi));
    for (const route of generated) {
      expect(route).toEqual(expect.objectContaining({
        authentication: expect.any(String),
        permission: expect.any(String),
        tenantRls: expect.any(Boolean),
        idempotency: expect.any(String),
        requestSchemas: expect.any(Array),
        responseSchemas: expect.any(Array),
        cacheHeaders: expect.any(Array),
        challengeExposure: expect.any(String),
        handlerFile: expect.stringMatching(/^apps\/api\/src\/http\/routes\//),
        handlerLine: expect.any(Number),
        ownershipCheck: expect.any(String),
      }));
      expect(route.handlerLine).toBeGreaterThan(0);
      expect(route.ownershipCheck).not.toBe('');
      expect(route.requestSchemas).not.toContain('undefined:undefined');
    }
  });

  it('explicita autenticação, autorização e isolamento das rotas messaging e Meta', async () => {
    const openapi = JSON.parse(await readFile(resolve(ROOT, 'docs/api/openapi.json'), 'utf8'));
    const inventory = await buildRouteInventory({ rootDirectory: ROOT, openapi });
    const routes = Object.fromEntries(inventory.map((route) => [`${route.method} ${route.path}`, route]));

    expect(routes['GET /v1/messaging/channels']).toMatchObject({
      authentication: 'JWT_WITH_ACTIVE_MEMBERSHIP', permission: 'OWNER_ADMIN_OPERATOR_VIEWER',
      tenantRls: true, idempotency: 'NOT_APPLICABLE', ownershipCheck: 'RLS_ORGANIZATION_FILTER',
    });
    expect(routes['GET /v1/messaging/channels/{id}/templates']).toMatchObject({
      authentication: 'JWT_WITH_ACTIVE_MEMBERSHIP', permission: 'OWNER_ADMIN_OPERATOR_VIEWER',
      tenantRls: true, ownershipCheck: 'RLS_ORGANIZATION_AND_CHANNEL_ID_BEFORE_META',
    });
    expect(routes['GET /v1/messaging/channels/{id}/conversations']).toMatchObject({
      authentication: 'JWT_WITH_ACTIVE_MEMBERSHIP', permission: 'OWNER_ADMIN_OPERATOR_VIEWER',
      tenantRls: true, ownershipCheck: 'RLS_ORGANIZATION_AND_CHANNEL_ID',
    });
    expect(routes['GET /v1/messaging/conversations/{id}/messages']).toMatchObject({
      authentication: 'JWT_WITH_ACTIVE_MEMBERSHIP', permission: 'OWNER_ADMIN_OPERATOR_VIEWER',
      tenantRls: true, ownershipCheck: 'RLS_ORGANIZATION_AND_CONVERSATION_ID',
    });
    expect(routes['POST /v1/messaging/channels/{id}/messages']).toMatchObject({
      authentication: 'JWT_WITH_ACTIVE_MEMBERSHIP', permission: 'OWNER_ADMIN_OPERATOR',
      tenantRls: true, idempotency: 'REQUIRED',
      ownershipCheck: 'RLS_ORGANIZATION_CHANNEL_CONVERSATION_AND_CONTACT_POLICY_BEFORE_OUTBOX',
    });
    expect(routes['PATCH /v1/messaging/channels/{id}/automation']).toMatchObject({
      authentication: 'JWT_WITH_ACTIVE_MEMBERSHIP', permission: 'OWNER_ADMIN',
      tenantRls: true, ownershipCheck: 'RLS_ORGANIZATION_CHANNEL_AND_SERVER_ORIGIN_ALLOWLIST',
    });
    expect(routes['PATCH /v1/messaging/conversations/{id}/mode']).toMatchObject({
      authentication: 'JWT_WITH_ACTIVE_MEMBERSHIP', permission: 'OWNER_ADMIN_OPERATOR',
      tenantRls: true, ownershipCheck: 'RLS_ORGANIZATION_AND_CONVERSATION_ID',
    });
    expect(routes['GET /v1/webhooks/meta']).toMatchObject({
      authentication: 'META_VERIFY_TOKEN_QUERY', permission: 'NOT_APPLICABLE_WEBHOOK',
      tenantRls: false, challengeExposure: 'VERIFIED_META_CHALLENGE_PLAINTEXT',
      ownershipCheck: 'SERVER_VERIFY_TOKEN_MATCH',
    });
    expect(routes['POST /v1/webhooks/meta']).toMatchObject({
      authentication: 'META_HMAC_SHA256_RAW_BODY', permission: 'NOT_APPLICABLE_WEBHOOK',
      tenantRls: true, idempotency: 'UPSTREAM_EVENT_ID_DEDUPE',
      ownershipCheck: 'SERVER_ASSET_BINDING_AND_RLS_CHANNEL_MATCH',
    });
  });

  it('resolve parameters e requestBody locais referenciados pelo OpenAPI', async () => {
    const openapi = JSON.parse(await readFile(resolve(ROOT, 'docs/api/openapi.json'), 'utf8'));
    const operation = openapi.paths['/v1/console/auth/select-organization'].post;
    openapi.components.requestBodies = {
      AuditSelectOrganization: operation.requestBody,
    };
    operation.requestBody = { $ref: '#/components/requestBodies/AuditSelectOrganization' };

    const inventory = await buildRouteInventory({ rootDirectory: ROOT, openapi });
    const route = inventory.find(({ method, path }) => (
      method === 'POST' && path === '/v1/console/auth/select-organization'
    ));

    expect(route.requestSchemas).toEqual([
      'body:application/json',
      'header:Origin',
    ]);
  });

  it('valida findings e strengths estritos e trata frontend/XSS e permissões como aplicáveis', async () => {
    const data = JSON.parse(await readFile(resolve(AUDIT_ROOT, 'findings.json'), 'utf8'));
    expect(() => assertAuditData(data)).not.toThrow();
    await expect(assertAuditEvidenceLocations(data, { rootDirectory: ROOT })).resolves.toBe(data);
    expect(data).toMatchObject({ schemaVersion: 1, findings: expect.any(Array), strengths: expect.any(Array) });
    expect(data.strengths.length).toBeGreaterThanOrEqual(5);
    expect([...data.findings, ...data.strengths]).toContainEqual(expect.objectContaining({
      category: 'INPUTS_XSS',
    }));
    expect(data.findings).not.toContainEqual(expect.objectContaining({
      category: 'INPUTS_XSS', status: 'NOT_APPLICABLE',
    }));
    expect(data.strengths).toContainEqual(expect.objectContaining({
      category: 'AUTHORIZATION_RBAC',
      description: expect.stringMatching(/frontend|navegador|browser/iu),
    }));
    for (const finding of data.findings) {
      expect(finding).toEqual(expect.objectContaining({
        category: expect.any(String), file: expect.any(String),
        lineStart: expect.any(Number), lineEnd: expect.any(Number),
        codeExcerptMasked: expect.any(String), exploitability: expect.any(String),
        exploitConditions: expect.any(String), acceptanceCriteria: expect.any(Array),
        suggestedLabels: expect.any(Array), issueMarkdown: expect.any(String),
      }));
    }
    expect([...new Set([...data.findings, ...data.strengths].map(({ category }) => category))].sort())
      .toEqual([...AUDIT_CATEGORIES].sort());
  });

  it('mantém a evidência da troca de tenant sobre o purge e a publicação da nova sessão', async () => {
    const data = JSON.parse(await readFile(resolve(AUDIT_ROOT, 'findings.json'), 'utf8'));
    const strength = data.strengths.find(({ id }) => id === 'JRC-STRENGTH-201');
    expect(strength).toBeDefined();

    const source = await readFile(resolve(ROOT, strength.file), 'utf8');
    const evidence = source
      .split(/\r?\n/u)
      .slice(strength.lineStart - 1, strength.lineEnd)
      .join('\n');

    expect(evidence).toMatch(/function purgeTenant\(\): number/u);
    expect(evidence).toMatch(/tenantGeneration \+= 1/u);
    expect(evidence).toMatch(/controller\.abort\(\)/u);
    expect(evidence).toMatch(/for \(const handler of purgeHandlers\) handler\(\)/u);
    expect(evidence).toMatch(/switchOrganization\(input\)/u);
    const purgeCall = evidence.indexOf('const generation = purgeTenant();');
    const sessionPublication = evidence.search(/return sessionMutation\(["']\/v1\/console\/auth\/switch-organization["']/u);
    expect(purgeCall).toBeGreaterThanOrEqual(0);
    expect(sessionPublication).toBeGreaterThan(purgeCall);
  });

  it('recusa evidência ausente ou com intervalo além do fim do arquivo', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jrc-audit-evidence-'));
    temporaryDirectories.push(directory);
    await mkdir(resolve(directory, 'docs/operations'), { recursive: true });
    await writeFile(resolve(directory, 'docs/operations/control.md'), 'linha 1\nlinha 2\n');
    const data = {
      schemaVersion: 1,
      generatedAt: '2026-09-06T00:00:00.000Z',
      findings: [],
      strengths: [{
        id: 'TEST-STRENGTH',
        title: 'Controle sintético',
        category: 'INPUTS_XSS',
        description: 'Evidência sintética.',
        file: 'docs/operations/control.md',
        lineStart: 1,
        lineEnd: 3,
        evidencePaths: ['docs/operations/control.md'],
      }],
    };

    await expect(assertAuditEvidenceLocations(data, { rootDirectory: directory }))
      .rejects.toThrow(/lineEnd.*2/u);

    data.strengths[0].lineEnd = 2;
    data.strengths[0].evidencePaths = ['docs/operations/missing.md'];
    await expect(assertAuditEvidenceLocations(data, { rootDirectory: directory }))
      .rejects.toThrow(/missing\.md/u);
  });

  it('trata evidência primária vazia como arquivo com zero linhas', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jrc-audit-empty-evidence-'));
    temporaryDirectories.push(directory);
    await mkdir(resolve(directory, 'docs/operations'), { recursive: true });
    await writeFile(resolve(directory, 'docs/operations/empty.md'), '');
    const data = {
      schemaVersion: 1,
      generatedAt: '2026-09-06T00:00:00.000Z',
      findings: [],
      strengths: [{
        id: 'TEST-EMPTY-EVIDENCE',
        title: 'Controle sem evidência',
        category: 'INPUTS_XSS',
        description: 'Evidência sintética vazia.',
        file: 'docs/operations/empty.md',
        lineStart: 1,
        lineEnd: 1,
        evidencePaths: ['docs/operations/empty.md'],
      }],
    };

    await expect(assertAuditEvidenceLocations(data, { rootDirectory: directory }))
      .rejects.toThrow(/lineEnd 1 exceeds .* EOF at line 0/u);
  });

  it('documenta uma Permissions-Policy de produção que nega capacidades não utilizadas', async () => {
    const runbook = await readFile(resolve(ROOT, 'docs/operations/web-console.md'), 'utf8');
    const header = /^Permissions-Policy:\s*(.+)$/mu.exec(runbook)?.[1];

    expect(header).toBeDefined();
    const directives = Object.fromEntries(header.split(',').map((directive) => {
      const [feature, allowlist] = directive.trim().split('=');
      return [feature, allowlist];
    }));
    expect(directives).toMatchObject({
      camera: '()',
      'display-capture': '()',
      geolocation: '()',
      microphone: '()',
      payment: '()',
      'publickey-credentials-get': '()',
      usb: '()',
    });
    expect(runbook).toMatch(/Confirmar .*Permissions-Policy.*ambiente publicado/iu);
  });

  it('usa no CI a mesma data de referência imutável do perfil do incremento', async () => {
    const workflow = await readFile(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const configuredEpoch = Number(/^\s*SOURCE_DATE_EPOCH:\s*"(\d+)"\s*$/mu.exec(workflow)?.[1]);
    const verification = JSON.parse(await readFile(resolve(AUDIT_ROOT, 'pdf-verification.json'), 'utf8'));

    expect(configuredEpoch).toBe(CURRENT_AUDIT_PROFILE.sourceDateEpoch);
    expect(verification.sourceDateEpoch).toBe(CURRENT_AUDIT_PROFILE.sourceDateEpoch);
  });

  it('mantém a validação recursiva do submódulo e um segredo HMAC real no CI', async () => {
    const submoduleGate = await readFile(resolve(ROOT, 'scripts/security/check-submodule-clean.mjs'), 'utf8');
    const workflow = await readFile(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(submoduleGate).toContain("'--ignore-submodules=none'");
    expect(submoduleGate).toContain("'submodule', 'status', '--recursive'");
    expect(workflow).toContain('AUDIT_FINGERPRINT_SECRET: ${{ secrets.AUDIT_FINGERPRINT_SECRET }}');
    expect(workflow).not.toContain('github.repository_id');
    expect(hasDivergentNestedSubmodule(' 3137df4 evolution-manager-v2')).toBe(false);
    expect(hasDivergentNestedSubmodule('+3137df4 evolution-manager-v2')).toBe(true);
    expect(hasDivergentNestedSubmodule('-3137df4 evolution-manager-v2')).toBe(true);
    expect(hasDivergentNestedSubmodule('U3137df4 evolution-manager-v2')).toBe(true);
  });

  it('gate bloqueia somente CRITICAL/HIGH abertos e nunca reescreve dados', () => {
    const base = { schemaVersion: 1, generatedAt: '2030-01-01T00:00:00.000Z', findings: [], strengths: [] };
    expect(gateAuditData(base)).toEqual({ blocked: false, blockingFindingIds: [] });
    expect(gateAuditData({ ...base, findings: [finding('HIGH', 'FIXED', 1)] })).toEqual({
      blocked: false, blockingFindingIds: [],
    });
    expect(gateAuditData({
      ...base,
      findings: [finding('LOW', 'OPEN', 1), finding('HIGH', 'OPEN', 2), finding('CRITICAL', 'ACCEPTED', 3)],
    })).toEqual({ blocked: true, blockingFindingIds: ['TEST-HIGH-OPEN'] });
  });

  it('scanner de bundles detecta canários sem retornar ou imprimir seus valores', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jrc-audit-bundle-'));
    temporaryDirectories.push(directory);
    await mkdir(resolve(directory, 'apps/api/dist'), { recursive: true });
    await mkdir(resolve(directory, 'node_modules/ignored/dist'), { recursive: true });
    await writeFile(
      resolve(directory, 'apps/api/dist/index.js'),
      `export const value = ${JSON.stringify(TEST_SECRET_CANARIES.apiKey)};`,
    );
    await writeFile(
      resolve(directory, 'node_modules/ignored/dist/index.js'),
      JSON.stringify(TEST_SECRET_CANARIES.password),
    );

    const findings = await scanCompiledBundle({
      rootDirectory: directory,
      fingerprintSecret: 'audit-fingerprint-secret-for-tests-only',
    });
    expect(findings).toEqual([
      expect.objectContaining({ scanner: 'COMPILED_BUNDLE', category: 'API_KEY', path: 'apps/api/dist/index.js' }),
    ]);
    const serialized = JSON.stringify(findings);
    for (const value of Object.values(TEST_SECRET_CANARIES)) expect(serialized).not.toContain(value);
  });

  it('inclui o bundle web e artefatos HTML/CSS na varredura sanitizada', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jrc-audit-web-bundle-'));
    temporaryDirectories.push(directory);
    await mkdir(resolve(directory, 'apps/web/dist/assets'), { recursive: true });
    await writeFile(
      resolve(directory, 'apps/web/dist/index.html'),
      `<meta name="fixture" content=${JSON.stringify(TEST_SECRET_CANARIES.selectionToken)}>`,
    );
    await writeFile(
      resolve(directory, 'apps/web/dist/assets/index.css'),
      `:root{--fixture:${JSON.stringify(TEST_SECRET_CANARIES.apiKey)}}`,
    );

    const findings = await scanCompiledBundle({
      rootDirectory: directory,
      fingerprintSecret: 'audit-fingerprint-secret-for-tests-only',
    });

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ scanner: 'COMPILED_BUNDLE', category: 'SELECTION_TOKEN', path: 'apps/web/dist/index.html' }),
      expect.objectContaining({ scanner: 'COMPILED_BUNDLE', category: 'API_KEY', path: 'apps/web/dist/assets/index.css' }),
    ]));
    for (const value of Object.values(TEST_SECRET_CANARIES)) {
      expect(JSON.stringify(findings)).not.toContain(value);
    }
  });

  it('detecta configuração VITE não aprovada sem ler ou retornar valores', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jrc-audit-vite-env-'));
    temporaryDirectories.push(directory);
    await mkdir(resolve(directory, 'apps/web/src'), { recursive: true });
    await writeFile(
      resolve(directory, 'apps/web/.env.production'),
      `VITE_EVOLUTION_API_KEY=${TEST_SECRET_CANARIES.evolutionApiKey}\nPUBLIC_NAME=JRC\n`,
    );
    await writeFile(
      resolve(directory, 'apps/web/src/config.ts'),
      'export const url = import.meta.env.VITE_ADMIN_API_URL;\n',
    );

    const findings = await scanForbiddenViteVariables({ rootDirectory: directory });

    expect(findings).toEqual([
      { name: 'VITE_EVOLUTION_API_KEY', path: 'apps/web/.env.production', line: 1 },
      { name: 'VITE_ADMIN_API_URL', path: 'apps/web/src/config.ts', line: 1 },
    ]);
    expect(JSON.stringify(findings)).not.toContain(TEST_SECRET_CANARIES.evolutionApiKey);
  });

  it('detecta assinaturas de credencial com alta confiança sem persistir o match', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jrc-audit-signature-'));
    temporaryDirectories.push(directory);
    await mkdir(resolve(directory, 'packages/security/dist'), { recursive: true });
    const syntheticToken = ['ghp', 'A'.repeat(40)].join('_');
    await writeFile(resolve(directory, 'packages/security/dist/leak.js'), syntheticToken);

    const findings = await scanCompiledBundle({
      rootDirectory: directory,
      fingerprintSecret: 'audit-fingerprint-secret-for-tests-only',
    });
    expect(findings).toEqual([
      expect.objectContaining({ category: 'GITHUB_TOKEN', path: 'packages/security/dist/leak.js' }),
    ]);
    expect(JSON.stringify(findings)).not.toContain(syntheticToken);
  });

  it('recusa varredura sem segredo de fingerprint mesmo quando não há achados', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jrc-audit-empty-'));
    temporaryDirectories.push(directory);
    await expect(scanCompiledBundle({ rootDirectory: directory, fingerprintSecret: '' }))
      .rejects.toThrow('Audit fingerprint secret');
    await expect(scanJrcHistory({ rootDirectory: directory, fingerprintSecret: '' }))
      .rejects.toThrow('Audit fingerprint secret');
  });

  it('scanner de histórico exclui upstream e mantém stdout/stderr sanitizados', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jrc-audit-history-'));
    temporaryDirectories.push(directory);
    execFileSync('git', ['init', '--quiet'], { cwd: directory });
    execFileSync('git', ['config', 'user.email', 'audit@example.test'], { cwd: directory });
    execFileSync('git', ['config', 'user.name', 'Audit Test'], { cwd: directory });
    await mkdir(resolve(directory, 'src'), { recursive: true });
    await mkdir(resolve(directory, 'upstream/evolution-api'), { recursive: true });
    await writeFile(resolve(directory, 'src/app.js'), JSON.stringify(TEST_SECRET_CANARIES.jwt));
    await writeFile(
      resolve(directory, 'upstream/evolution-api/upstream.js'),
      JSON.stringify(TEST_SECRET_CANARIES.evolutionApiKey),
    );
    execFileSync('git', ['add', '.'], { cwd: directory });
    execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: directory });

    const result = await scanJrcHistory({
      rootDirectory: directory,
      fingerprintSecret: 'audit-fingerprint-secret-for-tests-only',
    });
    expect(result).toEqual([
      expect.objectContaining({ scanner: 'JRC_GIT_HISTORY', category: 'JWT', path: 'src/app.js' }),
    ]);
    const serialized = JSON.stringify(result);
    for (const value of Object.values(TEST_SECRET_CANARIES)) expect(serialized).not.toContain(value);

    const cli = spawnSync(process.execPath, [
      resolve(ROOT, 'scripts/security/scan-jrc-history.mjs'), directory,
    ], {
      encoding: 'utf8',
      env: { ...process.env, AUDIT_FINGERPRINT_SECRET: 'audit-fingerprint-secret-for-tests-only' },
    });
    expect(cli.status).toBe(0);
    for (const value of Object.values(TEST_SECRET_CANARIES)) {
      expect(cli.stdout).not.toContain(value);
      expect(cli.stderr).not.toContain(value);
    }
  }, 15_000);

  it('resumo versionado contém somente agregados e fingerprints sanitizados', async () => {
    const summary = JSON.parse(await readFile(resolve(AUDIT_ROOT, 'secret-scan-summary.json'), 'utf8'));
    expect(summary).toEqual(expect.objectContaining({
      schemaVersion: 1,
      scans: expect.arrayContaining([
        expect.objectContaining({
          scanner: 'JRC_GIT_HISTORY',
          excluded: expect.arrayContaining(['upstream/evolution-api/**', 'scripts/security/secret-canaries.mjs']),
        }),
        expect.objectContaining({ scanner: 'COMPILED_BUNDLE' }),
      ]),
    }));
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toMatch(/codeExcerpt|secretValue|matchedValue/);
    for (const value of Object.values(TEST_SECRET_CANARIES)) expect(serialized).not.toContain(value);
  });
});

function finding(severity, status, issueNumber) {
  return {
    id: `TEST-${severity}-${status}`,
    title: 'Finding sintético',
    category: 'SECRETS_CRYPTOGRAPHY',
    severity,
    status,
    control: 'TEST-001',
    file: 'test/fixture.ts',
    lineStart: 1,
    lineEnd: 1,
    codeExcerptMasked: 'const secret = "[MASKED]";',
    description: 'Descrição sintética.',
    impact: 'Impacto sintético.',
    exploitability: 'Explorabilidade sintética.',
    exploitConditions: 'Condição sintética.',
    remediation: 'Correção sintética.',
    acceptanceCriteria: ['Critério sintético.'],
    verification: 'Verificação sintética.',
    suggestedLabels: ['security'],
    issueMarkdown: `--- ISSUE ${issueNumber} ---\n# Finding sintético\n--- FIM ISSUE ${issueNumber} ---`,
    evidencePaths: ['test/fixture.ts'],
  };
}
