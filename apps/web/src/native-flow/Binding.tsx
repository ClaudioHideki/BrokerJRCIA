import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { AutomationDefinitionV1 } from '@jrc/contracts';
import type { NativeEditorOptions } from './transport.js';
type Target = { integrationId: string; inboxId: number; ownerRevision: number };
type Activation = { id: string; revision: number; phase: string; expectedOwnerRevision: number; ready: boolean };
type Intent = { automationId: string; integrationId: string; version: number; scopeRevision: number; ownerRevision: number; cutoverId?: string };
type Options = NativeEditorOptions & { context: { scopes: string[] }; inboxNames?: Record<number, string> };
export function NativeBinding({ options }: { options: Options }) {
  const { id = '' } = useParams(), [targets, setTargets] = useState<Target[]>([]), [selected, setSelected] = useState('');
  const [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [activation, setActivation] = useState<Activation | null>(null), pending = useRef(false);
  const intent = useRef<Intent | null>(null);
  const controller = useRef<AbortController | null>(null), generation = useRef(0);
  const base = `/api/v1/accounts/${options.accountId}/jrc_flow_delegation/sessions/${options.handleId}/flows`;
  const canBind = options.context.scopes.includes('flow:bind');
  useEffect(() => {
    const current = ++generation.current, abort = new AbortController(); controller.current = abort;
    intent.current = null; setTargets([]); setSelected(''); setActivation(null); setUncertain(false); setNotice('');
    void options.request('get', base + '/targets', undefined, abort.signal).then(result => {
      if (current !== generation.current || abort.signal.aborted) return;
      const data = (result as { data: Target[] }).data; setTargets(data); setSelected(data[0]?.integrationId ?? '');
    }).catch(() => { if (!abort.signal.aborted) setNotice('Não foi possível carregar as caixas autorizadas.'); });
    return () => { generation.current++; abort.abort(); };
  }, [options, base, id]);
  async function rolledBack(signal: AbortSignal, live: () => boolean) {
    const result = await options.request('get', base + '/targets', undefined, signal) as { data: Target[] };
    if (!live()) return;
    setTargets(result.data); setSelected(result.data.some(item => item.integrationId === selected) ? selected : result.data[0]?.integrationId ?? '');
    intent.current = null; setActivation(null); setUncertain(false);
    setNotice('Reversão confirmada. A revisão da caixa foi atualizada; uma nova preparação exige sua confirmação.');
  }
  async function work(kind: 'prepare' | 'read' | 'reconcile') {
    if (pending.current || !selected || kind !== 'read' && !canBind) return;
    const current = generation.current, target = targets.find(item => item.integrationId === selected);
    if (!target || !controller.current || controller.current.signal.aborted) return;
    const signal = controller.current.signal, cutover = `${base}/integrations/${selected}/cutover`;
    const live = () => current === generation.current && !signal.aborted;
    pending.current = true; setBusy(true); setNotice('');
    let dispatched = false;
    try {
      if (kind === 'read') {
        const status = await options.request('get', cutover, undefined, signal) as Activation | null;
        if (live()) {
          const expected = intent.current;
          const sameIntent = expected?.automationId === id && expected.integrationId === selected &&
            status?.expectedOwnerRevision === expected.ownerRevision && (!expected.cutoverId || status.id === expected.cutoverId);
          if (!status || !expected || !sameIntent || status.phase === 'ACTIVATED' && !expected.cutoverId) {
            setActivation(null); setUncertain(true);
            setNotice('A ativação consultada não comprova o vínculo solicitado. Confira o Flow e a versão com a administração antes de continuar.');
            return;
          }
          if (status.phase === 'ROLLED_BACK') { await rolledBack(signal, live); return; }
          expected.cutoverId = status.id;
          setActivation(status); setUncertain(status.phase !== 'ACTIVATED');
          setNotice(status.phase === 'ACTIVATED' ? 'Ativação confirmada para esta preparação. Confira o Flow e a versão efetivamente vinculados antes de encerrar a revisão.'
            : status.ready ? 'A caixa está pronta. Confirme o vínculo da versão publicada.' : 'Ativação aguardando reconciliação; consulte o estado antes de continuar.');
        }
        return;
      }
      // Read the publication before fencing legacy responders. After preparation,
      // bind immediately within the short ownership proof lifetime.
      if (kind === 'prepare') {
        const draft = await options.request('get', `${base}/${id}`, undefined, signal) as AutomationDefinitionV1;
        if (!live()) return;
        if (!draft.activeVersion) throw new Error('Publique uma versão antes de vincular.');
        const scope = await options.request('get', `${base}/${id}/scope`, undefined, signal) as { revision: number };
        if (!live()) return;
        intent.current = { automationId: id, integrationId: selected, version: draft.activeVersion,
          scopeRevision: scope.revision, ownerRevision: target.ownerRevision };
      }
      const expected = intent.current;
      if (!expected || expected.automationId !== id || expected.integrationId !== selected) return;
      let prepared: Pick<Activation, 'id' | 'revision' | 'phase'>;
      if (kind === 'reconcile') {
        if (!activation || !['UNKNOWN', 'DRAINED', 'REQUESTED', 'FENCED'].includes(activation.phase)) return;
        dispatched = true;
        prepared = await options.request('post', cutover + '/reconcile', { cutoverId: activation.id,
          expectedCutoverRevision: activation.revision, expectedOwnerRevision: expected.ownerRevision }, signal) as Activation;
      } else {
        dispatched = true;
        prepared = await options.request('post', cutover + '/prepare', { expectedOwnerRevision: expected.ownerRevision }, signal) as Activation;
      }
      if (!live()) return;
      expected.cutoverId = prepared.id;
      setActivation({ ...prepared, expectedOwnerRevision: expected.ownerRevision, ready: prepared.phase === 'DRAINED' });
      if (prepared.phase === 'ROLLED_BACK') { await rolledBack(signal, live); return; }
      if (prepared.phase !== 'DRAINED') { setUncertain(true); setNotice('Preparação pendente. Consulte a ativação antes de prosseguir.'); return; }
      await options.request('post', `${base}/${expected.automationId}/bindings`, { integrationId: expected.integrationId, version: expected.version,
        expectedScopeRevision: expected.scopeRevision, expectedOwnerRevision: expected.ownerRevision, cutoverId: prepared.id }, signal);
      if (live()) { setUncertain(false); setActivation({ ...prepared, phase: 'ACTIVATED', expectedOwnerRevision: expected.ownerRevision, ready: false }); setNotice('Vínculo confirmado. Novas mensagens usarão esta versão.'); }
    } catch (reason) {
      if (live()) { if (dispatched) setUncertain(true); setNotice(reason instanceof Error ? reason.message : 'A ativação requer revisão da administração.'); }
    } finally { pending.current = false; if (live()) setBusy(false); }
  }
  return <section className="automation-page automation-narrow"><Link to={`/automations/${id}/edit`}>Voltar ao editor</Link>
    <h1>Vincular versão publicada</h1><p>Escolha a caixa. O Broker confirma a pausa dos executores anteriores e ativa uma única versão do bot.</p>
    <label>Caixa<select value={selected} disabled={busy || uncertain || activation?.phase === 'ACTIVATED'} onChange={event => { setSelected(event.target.value); setNotice(''); setActivation(null); }}>
      {targets.map(target => <option key={target.integrationId} value={target.integrationId}>{options.inboxNames?.[target.inboxId] ?? 'Caixa selecionada'}</option>)}
    </select></label>
    {!uncertain && activation?.phase !== 'ACTIVATED' && <button disabled={busy || !selected || !canBind} onClick={() => void work('prepare')}>Preparar e vincular</button>}
    {uncertain && <><button disabled={busy} onClick={() => void work('read')}>Consultar ativação</button>
      {activation && ['UNKNOWN', 'DRAINED', 'REQUESTED', 'FENCED'].includes(activation.phase) && <button disabled={busy || !canBind} onClick={() => void work('reconcile')}>Reconciliar e confirmar vínculo</button>}</>}
    <p role="status">{notice}</p></section>;
}
