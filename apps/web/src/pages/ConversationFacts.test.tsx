// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ConversationFacts } from './ConversationFacts.js';
import type { LocalConversationContext } from '@jrc/contracts';
const id = '11111111-2222-4333-8444-555555555555', channel = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const context: LocalConversationContext = { scope: { organizationId: id, channelId: channel, conversationId: id },
  revision: '3', status: 'RESOLVED', labels: [{ id, name: 'Financeiro' }],
  attributes: [{ key: 'active', name: 'Ativo', value: false }, { key: 'amount', name: 'Saldo', value: 0 }],
  privateNotes: [{ id, text: 'Análise privada da equipe', createdAt: '2026-10-15T12:00:00.000Z' }], notesTruncated: false };
it('shows local labels, typed attributes and private notes without a send or delivery claim', () => {
  render(<ConversationFacts context={context} organizationId={id} channelId={channel} conversationId={id} />);
  fireEvent.click(screen.getByText('Atributos da conversa'));
  expect(screen.getByText('Financeiro')).toBeVisible(); expect(screen.getByText('Não')).toBeVisible();
  expect(screen.getByText('0')).toBeVisible(); expect(screen.getByText('Análise privada da equipe')).toBeVisible();
  expect(screen.getByText(/não são enviadas ao WhatsApp/i)).toBeVisible();
  expect(screen.queryByRole('button')).toBeNull(); expect(screen.queryByText('SENT')).toBeNull();
});
it('removes an old context immediately when switching Account, box or conversation', () => {
  const { rerender } = render(<ConversationFacts context={context} organizationId={id} channelId={channel} conversationId={id} />);
  rerender(<ConversationFacts context={context} organizationId={id} channelId={id} conversationId={id} />);
  expect(screen.queryByText('Análise privada da equipe')).toBeNull();
  rerender(<ConversationFacts context={context} organizationId={channel} channelId={channel} conversationId={id} />);
  expect(screen.queryByText('Financeiro')).toBeNull();
});
it('states the private note page limit instead of silently claiming the full history', () => {
  render(<ConversationFacts context={{ ...context, notesTruncated: true }} organizationId={id} channelId={channel} conversationId={id} />);
  expect(screen.getByText(/100 notas internas mais recentes/i)).toBeVisible();
});
