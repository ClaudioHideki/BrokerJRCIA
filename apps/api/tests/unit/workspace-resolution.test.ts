import { describe, expect, it } from 'vitest';

import * as contracts from '@jrc/contracts';
import * as providers from '@jrc/providers';
import * as security from '@jrc/security';

describe('workspace source resolution', () => {
  it('resolve os três packages pelos nomes públicos durante os testes', () => {
    expect(contracts).toBeDefined();
    expect(providers).toBeDefined();
    expect(security).toBeDefined();
  });
});
