// @vitest-environment jsdom

import { useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionAction } from '@jrc/contracts';

import { ChallengePanel } from './ChallengePanel.js';

function ExpiringChallenge({ action }: { action: ConnectionAction }) {
  const [current, setCurrent] = useState<ConnectionAction | null>(action);
  return current ? <ChallengePanel action={current} onExpire={() => setCurrent(null)} /> : null;
}

describe('ChallengePanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T12:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('remove o desafio no instante de expiração sem interação do usuário', () => {
    render(<ExpiringChallenge action={{
      type: 'PAIRING_CODE',
      code: '123-456',
      expiresAt: '2030-01-01T12:00:01.000Z',
    }} />);
    expect(screen.getByText('123-456')).toBeVisible();

    act(() => vi.advanceTimersByTime(999));
    expect(screen.getByText('123-456')).toBeVisible();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText('123-456')).not.toBeInTheDocument();
  });

  it('nunca insere pairing code já expirado no DOM', () => {
    const onExpire = vi.fn();

    render(<ChallengePanel action={{
      type: 'PAIRING_CODE',
      code: 'expired-canary',
      expiresAt: '2030-01-01T11:59:59.999Z',
    }} onExpire={onExpire} />);

    expect(screen.queryByText('expired-canary')).not.toBeInTheDocument();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
