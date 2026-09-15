import { describe, expect, it } from 'vitest';
import { findUnpinnedImages } from '../scripts/check-compose-pins.mjs';

describe('baseline compose', () => {
  it('does not use latest or untagged images', async () => {
    expect(await findUnpinnedImages('infra/baseline/compose.yaml')).toEqual([]);
  });
});
