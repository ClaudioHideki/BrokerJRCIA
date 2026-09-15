import type { InstanceStatus } from '@jrc/contracts';

import { connectionStatusView } from '../status.js';

export function ConnectionStatus({ status }: { status: InstanceStatus }) {
  const view = connectionStatusView(status);
  return (
    <span className={`status status--${view.tone}`} role="status" aria-live="polite" aria-atomic="true">
      <span aria-hidden="true">{view.symbol}</span>
      {view.label}
    </span>
  );
}
