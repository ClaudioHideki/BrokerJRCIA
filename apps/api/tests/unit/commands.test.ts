import { describe, expect, it } from 'vitest';

import { runBootstrapCommand } from '../../src/commands/bootstrap.js';
import { runTenantCreateCommand } from '../../src/commands/tenant-create.js';

describe('administrative command secret boundaries', () => {
  it.each([
    ['--password', 'password-canary'],
    ['--password=password-canary'],
  ])('bootstrap rejeita senha em argv: %s', async (...argv) => {
    let prompted = false;

    await expect(runBootstrapCommand({
      argv,
      environment: {},
      readSecretValue: async () => {
        prompted = true;
        return 'unexpected';
      },
    })).rejects.toThrow(/secure input/i);
    expect(prompted).toBe(false);
  });

  it.each([
    ['--owner-password', 'password-canary'],
    ['--owner-password=password-canary'],
    ['--administrative-credential', 'admin-canary'],
    ['--administrative-credential=admin-canary'],
  ])('tenant:create rejeita segredo em argv: %s', async (...argv) => {
    let prompted = false;

    await expect(runTenantCreateCommand({
      argv,
      environment: {},
      readSecretValue: async () => {
        prompted = true;
        return 'unexpected';
      },
    })).rejects.toThrow(/secure input/i);
    expect(prompted).toBe(false);
  });
});
