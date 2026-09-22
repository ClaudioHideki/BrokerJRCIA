import { describe, expect, it } from 'vitest';

import { legacyArtifactChecksum } from '../../src/modules/automations/legacy-migration.js';

describe('legacy flow migration checksums', () => {
  it('is stable when object keys arrive in a different order', () => {
    const first = {
      draft: { nodes: [{ id: 'start', data: { z: 2, a: 1 } }], edges: [] },
      versions: [{ version: 1, graph: { beta: true, alpha: false } }],
    };
    const reordered = {
      versions: [{ graph: { alpha: false, beta: true }, version: 1 }],
      draft: { edges: [], nodes: [{ data: { a: 1, z: 2 }, id: 'start' }] },
    };

    expect(legacyArtifactChecksum(first)).toBe(legacyArtifactChecksum(reordered));
    expect(legacyArtifactChecksum(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes when array order or source content changes', () => {
    const source = { nodes: ['start', 'end'], metadata: { revision: 1 } };

    expect(legacyArtifactChecksum(source)).not.toBe(
      legacyArtifactChecksum({ nodes: ['end', 'start'], metadata: { revision: 1 } }),
    );
    expect(legacyArtifactChecksum(source)).not.toBe(
      legacyArtifactChecksum({ nodes: ['start', 'end'], metadata: { revision: 2 } }),
    );
  });
});
