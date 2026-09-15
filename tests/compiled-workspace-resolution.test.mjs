import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

describe('workspace compiled resolution', () => {
  it('resolve os exports compilados no runtime Node', () => {
    const script = [
      "await import('@jrc/contracts')",
      "await import('@jrc/providers')",
      "await import('@jrc/security')",
    ].join(';');

    expect(() => {
      execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: process.cwd(),
        stdio: 'pipe',
      });
    }).not.toThrow();
  });
});
