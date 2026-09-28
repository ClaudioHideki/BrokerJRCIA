// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ImportReview, type ImportReport } from './ImportReview.js';

describe('ImportReview', () => {
  it('groups a large incompatible n8n import by source node type while preserving node-level review', () => {
    const nodes: ImportReport['nodes'] = [
      { sourceId: 'start', sourceType: 'n8n-nodes-base.webhook', classification: 'EXACT', targetType: 'start', notes: [] },
      ...Array.from({ length: 27 }, (_, index) => ({
        sourceId: `code-${index + 1}`, sourceType: 'n8n-nodes-base.code', classification: 'UNSUPPORTED' as const, targetType: null,
        notes: ['Código JavaScript de origem não é executado.'],
      })),
      ...Array.from({ length: 11 }, (_, index) => ({
        sourceId: `switch-${index + 1}`, sourceType: 'n8n-nodes-base.switch', classification: 'UNSUPPORTED' as const, targetType: null,
        notes: ['Configure condição nativa equivalente.'],
      })),
    ];
    render(<ImportReview report={{
      summary: { total: 39, exact: 1, partial: 0, unsupported: 38, manualReviewRequired: true },
      nodes, warnings: [],
    }} />);

    expect(screen.getByText(/39 blocos: 1 compatíveis, 0 para revisar e 38 para substituir/)).toBeVisible();
    expect(screen.getByText(/A publicação exige adaptar os blocos/)).toBeVisible();
    fireEvent.click(screen.getByText(/Blocos que precisam de revisão/));
    expect(screen.getByText('n8n-nodes-base.code: 27 para substituir')).toBeVisible();
    expect(screen.getByText('n8n-nodes-base.switch: 11 para substituir')).toBeVisible();
    expect(screen.queryByText(/start/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('n8n-nodes-base.code: 27 para substituir'));
    const group = screen.getByText('n8n-nodes-base.code: 27 para substituir').closest('details');
    expect(group).not.toBeNull();
    expect(within(group!).getAllByRole('listitem')).toHaveLength(27);
    expect(within(group!).getByText(/\(code-1\)/)).toBeVisible();
  });
});
