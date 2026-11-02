import { createOriginCaptureHook } from './hook.mjs';
import { createOriginDispatcher } from './dispatcher.mjs';
import { createOriginHttpTransport } from './http-transport.mjs';
import { createOriginWorker } from './worker.mjs';
import { createOriginWebhookOwnershipGuard } from './webhook-ownership.mjs';

/** Deterministic lab assembly only. The source overlay explicitly rejects UNPROVEN ownership. */
export function createOriginLabBootstrap({ env, journal, binding, resolveBinding, transport, dispatch = {}, worker = {} }) {
  const frozenBinding = Object.freeze({ ...binding });
  const capture = createOriginCaptureHook({ env, journal, binding: frozenBinding });
  const deliver = createOriginHttpTransport({ ...transport, binding: frozenBinding });
  const dispatcher = createOriginDispatcher({ ...dispatch, env, journal, resolveBinding, deliver });
  const runner = createOriginWorker({ ...worker, dispatcher, binding: frozenBinding });
  const webhookGuard = createOriginWebhookOwnershipGuard({ env, journal, binding: frozenBinding, endpoint: transport.endpoint,
    allowInsecureLoopbackForTests: transport.allowInsecureLoopbackForTests, resolveBinding });
  return Object.freeze({ deliveryOwnership: 'UNPROVEN', capture: capture.capture, webhookGuard, start: runner.start, stop: runner.stop });
}
