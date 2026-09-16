import { EmbedStartedSchema, EmbedExchangeResultSchema, ConnectionResponseSchema, ConnectionHealthSchema,
  type EmbedConnection, type ConnectionAction, type ConnectionHealth } from '@jrc/contracts';
import { isContextGranted, type EmbedContext } from './context.js';

type Status = 'IDLE' | 'STARTING' | 'WAITING' | 'AUTHORIZED' | 'EXPIRED' | 'DENIED' | 'UNAVAILABLE';
export interface EmbedState {
  status: Status; connections: EmbedConnection[]; selected: string; expiresAt: number; accountId: number;
  action: ConnectionAction | null; health: ConnectionHealth | null; busy: boolean;
}
const empty = (status: Status): EmbedState => ({ status, connections: [], selected: '', expiresAt: 0, accountId: 0, action: null, health: null, busy: false });
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
class EmbedFailure extends Error { constructor(readonly status: number) { super('EMBED_REQUEST_FAILED'); } }

/** Credentials are private memory, never part of React state, storage, URLs or messages. */
export class EmbedSessionClient {
  #state = empty('IDLE'); #listeners = new Set<() => void>();
  #token: string | null = null; #verifier: string | null = null;
  #generation = 0; #selection = 0; #context: EmbedContext | null = null; #invalidContext = false;
  #abort = new AbortController(); #poll?: ReturnType<typeof setTimeout>; #expiry?: ReturnType<typeof setTimeout>;
  constructor(readonly embedId: string, private readonly fetchImpl: typeof fetch = fetch) {}
  snapshot = () => this.#state;
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  #publish(next: Partial<EmbedState>) { this.#state = { ...this.#state, ...next }; for (const listener of this.#listeners) listener(); }
  stop(status: Status = 'IDLE') {
    this.#generation++; this.#selection++; this.#abort.abort(); this.#abort = new AbortController();
    clearTimeout(this.#poll); clearTimeout(this.#expiry); this.#token = null; this.#verifier = null;
    this.#publish(empty(status));
  }
  #failed(error: unknown) { this.stop(error instanceof EmbedFailure && [401, 403, 404].includes(error.status) ? 'DENIED' : 'UNAVAILABLE'); }
  async #request(path: string, method: 'GET' | 'POST', body?: unknown, bearer = false) {
    const fetchImpl = this.fetchImpl;
    const response = await fetchImpl(path, { method, cache: 'no-store', credentials: 'omit',
      signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(20000)]),
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(bearer && this.#token ? { Authorization: `Bearer ${this.#token}` } : {}),
        ...(path.endsWith('/pair') ? { 'Idempotency-Key': crypto.randomUUID() } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new EmbedFailure(response.status);
    return response.json() as Promise<unknown>;
  }
  async begin(): Promise<string | null> {
    this.stop('STARTING'); const generation = this.#generation;
    try {
      this.#verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.#verifier))));
      if (generation !== this.#generation) return null;
      const started = EmbedStartedSchema.parse(await this.#request('/v1/embed/authorizations', 'POST', { embedId: this.embedId, challenge }));
      if (generation !== this.#generation) return null;
      const deadline = Math.min(Date.parse(started.expiresAt), Date.now() + 120000);
      if (deadline <= Date.now()) { this.stop('EXPIRED'); return null; }
      this.#publish({ status: 'WAITING', expiresAt: deadline });
      this.#expiry = setTimeout(() => this.stop('EXPIRED'), deadline - Date.now());
      this.#poll = setTimeout(() => void this.#exchange(started.requestId, generation), 1000);
      return `/embed/authorize?requestId=${started.requestId}`;
    } catch (error) { if (generation === this.#generation) this.#failed(error); return null; }
  }
  async #exchange(requestId: string, generation: number) {
    if (generation !== this.#generation || !this.#verifier) return;
    try {
      const result = EmbedExchangeResultSchema.parse(await this.#request(`/v1/embed/authorizations/${requestId}/exchange`, 'POST', { verifier: this.#verifier }));
      if (generation !== this.#generation) return;
      if (result.status === 'PENDING') { this.#poll = setTimeout(() => void this.#exchange(requestId, generation), 1000); return; }
      if (this.#invalidContext || (this.#context && !isContextGranted(this.#context, result))) { this.stop('DENIED'); return; }
      const expiresAt = Math.min(Date.parse(result.expiresAt), Date.now() + 300000);
      if (expiresAt <= Date.now()) { this.stop('EXPIRED'); return; }
      this.#verifier = null; this.#token = result.token; clearTimeout(this.#expiry);
      const selected = (this.#context ? result.connections.find(c => c.inboxId === this.#context!.inboxId) : result.connections[0])?.integrationId ?? '';
      this.#publish({ status: 'AUTHORIZED', accountId: result.accountId, connections: result.connections, expiresAt, selected });
      this.#expiry = setTimeout(() => this.stop('EXPIRED'), expiresAt - Date.now());
      await this.refresh();
      this.#scheduleHealth(generation);
    } catch (error) {
      if (generation !== this.#generation) return;
      if (error instanceof EmbedFailure && error.status === 429) this.#poll = setTimeout(() => void this.#exchange(requestId, generation), 1000);
      else this.#failed(error);
    }
  }
  #scheduleHealth(generation: number) {
    if (generation !== this.#generation || this.#state.status !== 'AUTHORIZED') return;
    this.#poll = setTimeout(async () => { await this.refresh(); this.#scheduleHealth(generation); }, 5000);
  }
  #active() {
    if (this.#state.status !== 'AUTHORIZED' || !this.#token) return false;
    if (this.#state.expiresAt <= Date.now()) { this.stop('EXPIRED'); return false; }
    return true;
  }
  context(context: EmbedContext | null) {
    this.#invalidContext = context === null;
    if (context && JSON.stringify(context) === JSON.stringify(this.#context)) return;
    this.#context = context; this.#selection++; this.#publish({ action: null, health: null, busy: false });
    if (!context) { if (this.#state.status === 'AUTHORIZED') this.stop('DENIED'); return; }
    if (this.#state.status === 'AUTHORIZED') {
      if (!isContextGranted(context, this.#state)) this.stop('DENIED');
      else this.#publish({ selected: this.#state.connections.find(c => c.inboxId === context.inboxId)!.integrationId });
    }
  }
  select(id: string) {
    if (!this.#active() || !this.#state.connections.some(c => c.integrationId === id)) return;
    if (this.#context && this.#state.connections.find(c => c.integrationId === id)?.inboxId !== this.#context.inboxId) return;
    this.#selection++; this.#publish({ selected: id, action: null, health: null, busy: false }); void this.refresh();
  }
  clearAction = () => { this.#publish({ action: null }); };
  async refresh() {
    if (!this.#active() || !this.#state.selected) return;
    const generation = this.#generation, selection = this.#selection, id = this.#state.selected;
    try {
      const raw = await this.#request(`/v1/embed/connections/${id}/status`, 'GET', undefined, true);
      if (generation !== this.#generation || selection !== this.#selection || !this.#active()) return;
      const health = ConnectionHealthSchema.parse(raw);
      if (health.integrationId !== id) throw new Error('MISMATCH');
      this.#publish({ health, ...(!health.allowedActions.includes('pair') || health.instanceStatus === 'CONNECTED' ? { action: null } : {}) });
    } catch (error) { if (generation === this.#generation && selection === this.#selection) this.#failed(error); }
  }
  async pair() {
    if (!this.#active() || this.#state.busy || !this.#state.connections.find(c => c.integrationId === this.#state.selected)?.canPair) return;
    const generation = this.#generation, selection = this.#selection, id = this.#state.selected;
    this.#publish({ busy: true, action: null });
    try {
      const raw = await this.#request(`/v1/embed/connections/${id}/pair`, 'POST', {}, true);
      if (generation !== this.#generation || selection !== this.#selection || !this.#active()) return;
      const result = ConnectionResponseSchema.parse(raw);
      if (this.#state.health && result.instance.id !== this.#state.health.instanceId) throw new Error('MISMATCH');
      const action = result.action;
      if (action.type === 'REDIRECT' || action.type === 'EMBEDDED_SIGNUP') throw new Error('INVALID_ACTION');
      this.#publish({ action: 'expiresAt' in action && Date.parse(action.expiresAt) <= Date.now() ? null : action });
    } catch (error) { if (generation === this.#generation && selection === this.#selection) this.#failed(error); }
    finally { if (generation === this.#generation && selection === this.#selection) this.#publish({ busy: false }); }
  }
}
