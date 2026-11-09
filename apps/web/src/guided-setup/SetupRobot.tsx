import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { AutomationDefinitionV1, AutomationPublishedVersionV1, GuidedSetup, SetupSelection } from '@jrc/contracts';
import { ApiClientError, type ApiClient } from '../api/client.js';
import { listAutomations, listVersions } from '../automations/api.js';
import { PackageImport } from './PackageImport.js';
import { AutomationPackageSchema, parsePackage, type PackageRecord } from './api.js';
import { setupError } from './useGuidedSetup.js';

const requirementNames: Record<string, string> = { CREDENTIAL: 'Credencial local', HANDOFF: 'Caixa e destino humano', CHANNEL: 'Caixa do atendimento',
  RESOURCE: 'Etiqueta ou atributo local', MEDIA: 'Arquivo desta empresa', DOMAIN: 'Configuração do módulo de destino' };
export function SetupRobot({ client, row, disabled, save, action }: { client: ApiClient; row: GuidedSetup; disabled: boolean;
  action?(name: string): Promise<unknown> | null;
  save(selection: SetupSelection): Promise<unknown> | null }) {
  const [flows, setFlows] = useState<AutomationDefinitionV1[]>([]), [versions, setVersions] = useState<AutomationPublishedVersionV1[]>([]);
  const [selected, setSelected] = useState(row.selection.automationId ?? ''), [version, setVersion] = useState(row.selection.version ?? 0);
  const [bundle, setBundle] = useState<PackageRecord | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const generation = useRef(0), publication = useRef<{ key: string; revision: number } | null>(null);
  useEffect(() => { setSelected(row.selection.automationId ?? ''); setVersion(row.selection.version ?? 0); }, [row.selection.automationId, row.selection.version]);
  useEffect(() => {
    const current = ++generation.current; setFlows([]); setError('');
    void listAutomations(client).then(values => {
      if (values.some(value => value.organizationId !== row.organizationId)) throw new ApiClientError('O catálogo de robôs não corresponde à empresa.', 409);
      if (current === generation.current) setFlows(values.filter(flow => flow.lifecycleStatus !== 'ARCHIVED'));
    }).catch(reason => { if (current === generation.current) setError(setupError(reason)); });
    if (row.selection.packageId) void client.request(`/v1/automation-packages/${row.selection.packageId}`).then(value => {
      const parsed = parsePackage(row.organizationId, value); if (current === generation.current) setBundle(parsed);
    }).catch(reason => { if (current === generation.current) setError(setupError(reason)); });
    else setBundle(null);
    return () => { generation.current++; publication.current = null; };
  }, [client, row.organizationId, row.selection.packageId, reload]);
  useEffect(() => {
    let alive = true; setVersions([]);
    if (selected) void listVersions(client, selected).then(values => {
      if (values.some(value => value.organizationId !== row.organizationId || value.automationId !== selected)) throw new ApiClientError('As versões não correspondem ao robô desta empresa.', 409);
      if (!alive) return;
      setVersions(values); setVersion(value => values.some(item => item.version === value) ? value : values[0]?.version ?? 0);
    }).catch(reason => { if (alive) setError(setupError(reason)); });
    return () => { alive = false; };
  }, [client, row.organizationId, selected, reload]);
  function selectionFor(id: string, selectedVersion?: number, packageId?: string): SetupSelection {
    const { automationId: _flow, version: _version, packageId: _package, ...selection } = row.selection;
    return { ...selection, ...(packageId ? { packageId } : {}), automationId: id, ...(selectedVersion ? { version: selectedVersion } : {}) };
  }
  async function exportPackage() {
    if (!selected || !version || busy) return;
    const current = generation.current; setBusy(true); setError('');
    try {
      const portable = AutomationPackageSchema.parse(await client.request(`/v1/automations/${selected}/package?version=${version}`));
      if (current !== generation.current) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(portable, null, 2)], { type: 'application/json' }));
      try { const link = document.createElement('a'); link.href = url; link.download = 'robo-pacote-portatil.json'; link.click(); }
      finally { URL.revokeObjectURL(url); }
    } catch (reason) { if (current === generation.current) setError(setupError(reason)); }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function publishBundle() {
    if (!bundle || busy || disabled) return;
    const current = generation.current; setBusy(true); setError('');
    publication.current ??= { key: crypto.randomUUID(), revision: bundle.revision };
    try {
      const result = parsePackage(row.organizationId, await client.request(`/v1/automation-packages/${bundle.id}/publish`, {
        method: 'POST', headers: { 'Idempotency-Key': publication.current.key }, body: JSON.stringify({ revision: publication.current.revision }),
      }));
      if (current !== generation.current) return;
      setBundle(result); publication.current = null;
      if (!Object.hasOwn(result.publications, result.rootKey)) throw new ApiClientError('A publicação da raiz ainda não foi confirmada.', 409);
      await save(selectionFor(result.rootId, result.publications[result.rootKey]!.version, result.id));
      if (current === generation.current) setReload(value => value + 1);
    } catch (reason) { if (current === generation.current) setError(setupError(reason)); }
    finally { if (current === generation.current) setBusy(false); }
  }
  return <section className="panel"><h3>Robô e vínculos</h3>{error && <p role="alert">{error}</p>}
    <p>Escolha uma versão publicada ou importe um pacote. O atendimento só será ativado depois da homologação.</p>
    <label>Robô desta empresa<select value={selected} disabled={disabled || busy} onChange={event => { setSelected(event.target.value); setVersion(0); }}>
      <option value="">Selecione pelo nome</option>{flows.map(flow => <option key={flow.id} value={flow.id}>{flow.name}{flow.activeVersion ? '' : ' · Rascunho'}</option>)}
    </select></label>
    <label>Versão publicada<select value={version} disabled={disabled || busy || !versions.length} onChange={event => setVersion(Number(event.target.value))}>
      {!versions.length && <option value={0}>Publique o robô para escolher uma versão</option>}{versions.map(item => <option key={item.version} value={item.version}>Versão {item.version}</option>)}
    </select></label>
    <button className="button button--primary" disabled={disabled || busy || !selected} onClick={() => void save(selectionFor(selected, version || undefined,
      selected === row.selection.automationId ? row.selection.packageId : undefined))}>Salvar robô selecionado</button>
    <button className="button button--secondary" disabled={busy} onClick={() => setReload(value => value + 1)}>Atualizar robôs e vínculos</button>
    <button className="button button--secondary" disabled={busy || !selected || !version || !versions.some(item => item.version === version)} onClick={() => void exportPackage()}>Exportar pacote portátil</button>
    {selected && <p><Link to={`/automations/${selected}/edit?setup=${row.id}`}>Editar e simular o robô no Flow</Link></p>}
    {!disabled && <PackageImport client={client} organizationId={row.organizationId} onImported={async result => {
      setBundle(result); setSelected(result.rootId); setVersion(0); await save(selectionFor(result.rootId, undefined, result.id)); setReload(value => value + 1);
    }} />}
    {bundle && <div className="panel"><h4>Pacote importado</h4><p>{bundle.flows.length} fluxo(s). Os recursos de origem precisam ser selecionados nesta empresa.</p>
      {bundle.state === 'DRAFT' && action && <><p>Aplique a caixa e o destino humano escolhidos na etapa anterior aos rascunhos deste pacote. Credenciais, arquivos e recursos específicos continuam sendo selecionados em cada bloco.</p>
        <button className="button button--secondary" disabled={disabled || busy} onClick={async () => {
          const current = generation.current; const result = await action('package-bindings');
          if (result && current === generation.current) setReload(value => value + 1);
        }}>Aplicar caixa e destino humano aos rascunhos</button></>}
      <ul>{bundle.flows.map(flow => <li key={flow.id}><Link to={`/automations/${flow.id}/edit?setup=${row.id}`}>{flow.name}</Link>
        <ul>{bundle.requirements.filter(requirement => requirement.flowKey === flow.key).map(requirement => <li key={`${requirement.nodeId}:${requirement.kind}`}>
          <Link to={`/automations/${flow.id}/edit?setup=${row.id}&node=${encodeURIComponent(requirement.nodeId)}`}>{requirementNames[requirement.kind]} · Bloco {requirement.nodeId}</Link>
        </li>)}</ul></li>)}</ul>
      {bundle.state !== 'PUBLISHED' && <button className="button button--primary" disabled={disabled || busy || bundle.state === 'PUBLISHING'} onClick={() => void publishBundle()}>Publicar pacote</button>}
      {bundle.state === 'PUBLISHED' && <p>Pacote publicado. Confira a versão da raiz selecionada acima.</p>}
    </div>}
  </section>;
}
