// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ConnectionStatus } from './ConnectionStatus.js';

describe('ConnectionStatus', () => {
  it('anuncia mudanças de status sem depender apenas do ícone ou da cor', () => {
    const rendered = render(<ConnectionStatus status="CONNECTING" />);

    expect(screen.getByRole('status')).toHaveTextContent('Conectando');
    rendered.rerender(<ConnectionStatus status="CONNECTED" />);
    expect(screen.getByRole('status')).toHaveTextContent('Conectada');
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });
});
