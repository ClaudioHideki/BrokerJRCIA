// @vitest-environment jsdom
import { act, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { mountNativeFlowEditor, type NativeFlowMountOptions } from './entry.js';
const org = '11111111-2222-4333-8444-555555555555', handle = '12345678-1234-4234-8234-123456789abc';
const integration = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
function options(): NativeFlowMountOptions {
  return { accountId: 3, handleId: handle, integrationIds: [integration],
    context: { organizationId: org, accountId: 3, actorId: 9, scopes: ['flow:read'], expiresAt: new Date(Date.now() + 60000).toISOString() },
    request: vi.fn(async (_method, path) => path.endsWith('/status') ? { state: 'AVAILABLE', canEdit: true, canExecute: true } : { data: [], nextCursor: null }) };
}
it('isolates editor styling in its host and aborts its Account session on unmount', async () => {
  const element = document.createElement('div'); document.body.append(element);
  const settings = options(); let close!: () => void;
  await act(async () => { close = mountNativeFlowEditor(element, settings); });
  await waitFor(() => expect(element.shadowRoot?.textContent).toContain('Flows das caixas selecionadas'));
  expect(element.querySelector('link')).toBeNull();
  expect(element.shadowRoot?.querySelector('link')?.getAttribute('href')).toBe('/jrc-flow-editor/editor.css?v=development');
  expect(element.shadowRoot?.textContent).not.toContain('Nova automação ou importar');
  const call = vi.mocked(settings.request).mock.calls.find(args => args[1].endsWith('/flows'))!;
  expect(call[3]?.aborted).toBe(false);
  await act(async () => { close(); });
  expect(call[3]?.aborted).toBe(true); expect(element.shadowRoot?.childElementCount).toBe(0); element.remove();
});
it('rejects a context for another Account before mounting or sending a request', () => {
  const settings = options(); settings.context.accountId = 4;
  expect(() => mountNativeFlowEditor(document.createElement('div'), settings)).toThrow('FLOW_INVALID_CONTEXT');
  expect(settings.request).not.toHaveBeenCalled();
});
it('rejects an expired session instead of restoring a Broker console login', () => {
  const settings = options(); settings.context.expiresAt = '2020-01-01T00:00:00.000Z';
  expect(() => mountNativeFlowEditor(document.createElement('div'), settings)).toThrow('FLOW_SESSION_EXPIRED');
  expect(settings.request).not.toHaveBeenCalled();
});
