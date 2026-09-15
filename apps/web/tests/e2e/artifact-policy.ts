import { resolve } from 'node:path';

// Número fictício: fixture exclusiva do BrowserE2eFakeProvider, nunca do smoke real.
export const SYNTHETIC_PAIRING_HINT = '12025550123';

export function resolveE2eScreenshotDirectory(
  rootDirectory = process.cwd(),
  environment: Record<string, string | undefined> = process.env,
): string {
  const relativeDirectory = environment.JRC_E2E_CAPTURE_DOCS === 'true'
    ? 'docs/security/phase-1-increment-2/screenshots'
    : 'test-results/security-screenshots';
  return resolve(rootDirectory, relativeDirectory);
}
