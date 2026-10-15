import { createRoot } from 'react-dom/client';
import { useMemo, type CSSProperties } from 'react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router';
import { jrcCssVariables } from '@jrc/ui';
import { AutomationEditorSurface } from '../pages/AutomationStudio.js';
import { ApiClientError, type ApiClient } from '../api/client.js';
import { createNativeEditorTransport, type NativeEditorOptions } from './transport.js';
import { NativeNewFlow, NativeVersions, NativeWorkspace } from './workspace.js';
import { NativeBinding } from './Binding.js';
import '../app/console.css';
import './native.css';
declare const __JRC_NATIVE_EDITOR_SOURCE__: string;
export type NativeFlowMountOptions = NativeEditorOptions & {
  context: { organizationId: string; accountId: number; actorId: number; scopes: string[]; expiresAt: string };
  inboxNames?: Record<number, string>;
};
function Editor({ options }: { options: NativeFlowMountOptions }) {
  const { id = '' } = useParams();
  const client = useMemo(() => createNativeEditorTransport({ ...options, rootAutomationId: id }) as ApiClient, [options, id]);
  return <AutomationEditorSurface key={id} client={client} organizationId={options.context.organizationId}
    administrator={options.context.scopes.includes('flow:edit')} canPublish={options.context.scopes.includes('flow:publish')}
    scopeKey={`${options.accountId}:${options.context.actorId}:${options.handleId}`} bindingPath={`/automations/${id}/bind`} />;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function mountNativeFlowEditor(element: HTMLElement, options: NativeFlowMountOptions): () => void {
  const context = options.context;
  if (context.accountId !== options.accountId || !uuid.test(context.organizationId) ||
      !Number.isSafeInteger(context.actorId) || context.actorId < 1 || !Array.isArray(context.scopes) ||
      !context.scopes.includes('flow:read') || context.scopes.some(scope => !['flow:read', 'flow:edit', 'flow:publish', 'flow:bind'].includes(scope))) {
    throw new Error('FLOW_INVALID_CONTEXT');
  }
  const expires = Date.parse(context.expiresAt);
  if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error('FLOW_SESSION_EXPIRED');
  const controller = new AbortController();
  const request: NativeEditorOptions['request'] = async (method, path, body, signal, key, metadata) => {
    if (Date.now() >= expires) throw new ApiClientError('A sessão Flow expirou. Abra uma nova sessão nesta conta.', 403, undefined, 'FLOW_SESSION_EXPIRED');
    try {
      return await options.request(method, path, body, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, key, metadata);
    } catch (reason) {
      if (controller.signal.aborted || signal?.aborted) throw new DOMException('Sessão encerrada.', 'AbortError');
      const response = (reason as { response?: { status?: number; data?: { code?: string; requestId?: string } } }).response;
      throw new ApiClientError('Não foi possível concluir a operação Flow. Atualize a sessão ou verifique a configuração desta conta.',
        response?.status ?? 503, response?.data?.requestId, response?.data?.code);
    }
  };
  const bound = { ...options, request }, client = createNativeEditorTransport(bound) as ApiClient;
  const shadow = element.shadowRoot ?? element.attachShadow({ mode: 'open' });
  shadow.replaceChildren();
  const source = typeof __JRC_NATIVE_EDITOR_SOURCE__ === 'undefined' ? 'development' : __JRC_NATIVE_EDITOR_SOURCE__;
  const stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = '/jrc-flow-editor/editor.css?v=' + source;
  const container = document.createElement('div'); shadow.append(stylesheet, container);
  const root = createRoot(container); let closed = false;
  root.render(<div className="jrc-app native-flow-app" style={jrcCssVariables as CSSProperties}><MemoryRouter initialEntries={['/automations']}><Routes>
    <Route path="/automations" element={<NativeWorkspace client={client} canEdit={context.scopes.includes('flow:edit')} />} />
    <Route path="/automations/new" element={<NativeNewFlow client={client} canEdit={context.scopes.includes('flow:edit')} />} />
    <Route path="/automations/:id/edit" element={<Editor options={bound} />} />
    <Route path="/automations/:id/versions" element={<NativeVersions client={client} />} />
    <Route path="/automations/:id/bind" element={<NativeBinding options={bound} />} />
  </Routes></MemoryRouter></div>);
  const timer = window.setTimeout(() => {
    if (closed) return; controller.abort(); root.render(<p role="status">A sessão Flow expirou. Encerre e abra uma nova sessão nesta conta.</p>);
  }, Math.min(expires - Date.now(), 2_147_483_647));
  return () => { if (closed) return; closed = true; window.clearTimeout(timer); controller.abort(); root.unmount(); shadow.replaceChildren(); };
}
