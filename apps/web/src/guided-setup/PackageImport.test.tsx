// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client.js';
it('does not upload or import a file whose reading finishes after leaving the tenant', async () => {
  const path = './PackageImport.js';
  const mod = await import(/* @vite-ignore */ path).catch(() => null); expect(mod).not.toBeNull();
  const PackageImport = mod!.PackageImport;
  const request = vi.fn(), onImported = vi.fn();
  let resolve: (value: string) => void = () => {};
  const file = new File(['{}'], 'robot.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: () => new Promise<string>(done => { resolve = done; }) });
  const view = render(<PackageImport client={{ request } as unknown as ApiClient} organizationId="11111111-1111-4111-8111-111111111111" onImported={onImported} />);
  fireEvent.change(screen.getByLabelText('Arquivo do robô JSON'), { target: { files: [file] } });
  view.unmount();
  await act(async () => { resolve('{}'); });
  expect(request).not.toHaveBeenCalled(); expect(onImported).not.toHaveBeenCalled();
});
