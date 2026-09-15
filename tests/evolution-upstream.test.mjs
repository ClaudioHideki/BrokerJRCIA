import { describe, expect, it } from 'vitest';
import { checkEvolutionUpstream } from '../scripts/check-evolution-upstream.mjs';

describe('Evolution upstream baseline', () => {
  it('pins the official source and preserves required legal notices', async () => {
    const result = await checkEvolutionUpstream(process.cwd());

    expect(result.missing).toEqual([]);
    expect(result.usesOfficialRepository).toBe(true);
    expect(result.commitIsPinned).toBe(true);
    expect(result.isPinnedGitlink).toBe(true);
    expect(result.hasAdminUsageNotice).toBe(true);
  });
});
