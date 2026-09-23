import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const text = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

describe('release hardening', () => {
  it.each(['.github/workflows/ci.yml', '.github/workflows/images.yml'])('%s pins actions and service images', async path => {
    const source = await text(path);
    for (const line of source.split(/\r?\n/).filter(line => /\buses:\s*/.test(line))) {
      expect(line, `movable action reference in ${path}`).toMatch(/uses:\s*[^@\s]+@[a-f0-9]{40}(?:\s*#.*)?$/);
    }
    for (const line of source.split(/\r?\n/).filter(line => /^\s+image:\s*(?:postgres|redis):/.test(line))) {
      expect(line, `movable service image in ${path}`).toMatch(/@sha256:[a-f0-9]{64}$/);
    }
  });

  it('publishes attestations and signs only explicitly approved image digests', async () => {
    const source = await text('.github/workflows/images.yml');
    expect(source).toContain('component:');
    expect(source).toContain("inputs.component == 'all' || inputs.component == 'api'");
    expect(source).toContain("inputs.component == 'all' || inputs.component == 'web'");
    expect(source).toContain('sbom: true');
    expect(source).toContain('provenance: mode=max');
    expect(source).toContain('cosign sign --yes "$IMAGE_BASE-api@${{ steps.api.outputs.digest }}"');
    expect(source).toContain('cosign sign --yes "$IMAGE_BASE-web@${{ steps.web.outputs.digest }}"');
    expect(source.match(/if: \$\{\{ inputs\.publish \}\}/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('uses digest-only application promotion and strong platform authentication in Dokploy', async () => {
    const [compose, environment] = await Promise.all([
      text('infra/dokploy/compose.yaml'), text('infra/dokploy/.env.example'),
    ]);
    expect(compose).toContain('image: ${JRC_API_IMAGE:?required}');
    expect(compose).toContain('image: ${JRC_WEB_IMAGE:?required}');
    expect(compose).toContain('PLATFORM_LOGIN_MODE: ${PLATFORM_LOGIN_MODE:-password_totp}');
    expect(environment).toContain('JRC_API_IMAGE=ghcr.io/claudiohideki/brokerjrcia-api@sha256:replace');
    expect(environment).toContain('JRC_WEB_IMAGE=ghcr.io/claudiohideki/brokerjrcia-web@sha256:replace');
    expect(environment).toContain('PLATFORM_LOGIN_MODE=password_totp');
  });
});
