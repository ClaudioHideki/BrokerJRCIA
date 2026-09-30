import { useEffect, useRef, useState } from 'react';
import { GroupCompanyRemoval, GroupCompanyRemovalLookup } from './GroupCompanyRemoval.js';

interface Group { id: string; name: string; revision: number; organizationIds: string[] }
interface RemovalPreview { id: string; name: string; revision: number; organizations: { id: string; name: string }[] }
interface Props {
  request: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
  companies: { id: string; name: string }[];
  admin: boolean;
  disabled: boolean;
}

export function EconomicGroups({ request, companies, admin, disabled }: Props) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selected, setSelected] = useState<Group | null>(null);
  const [ids, setIds] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [updatedName, setUpdatedName] = useState('');
  const [preview, setPreview] = useState<RemovalPreview | null>(null);
  const [detachCompanies, setDetachCompanies] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [companyRemoval,setCompanyRemoval]=useState(false);
  const current = useRef(0);
  const api = useRef(request);
  api.current = request;
  const locked = disabled || busy;
  const editingLocked = locked || preview !== null;

  async function load() {
    const version = ++current.current;
    setBusy(true); setError(''); setNotice(''); setSelected(null); setPreview(null); setDetachCompanies(false);setCompanyRemoval(false);
    try {
      const loaded: Group[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const result: { data: Group[]; nextCursor?: string } = await api.current(`/groups${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
        if (version !== current.current) return;
        loaded.push(...result.data);
        cursor = result.nextCursor;
        if (cursor) {
          if (seen.has(cursor)) throw new Error('A lista de grupos não avançou. Atualize e tente novamente.');
          seen.add(cursor);
        }
      } while (cursor);
      if (version === current.current) setGroups(loaded);
    } catch (e) {
      if (version === current.current) setError((e as Error).message);
    } finally { if (version === current.current) setBusy(false); }
  }
  useEffect(() => { void load(); return () => { current.current++; }; }, []);

  async function save(create: boolean) {
    const version = current.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const group = create
        ? await api.current<Group>('/groups', 'POST', { name })
        : await api.current<Group>(`/groups/${selected!.id}/organizations`, 'PUT', { revision: selected!.revision, organizationIds: ids });
      if (version !== current.current) return;
      setGroups(items => [...items.filter(item => item.id !== group.id), group]);
      setSelected(group); setIds(group.organizationIds); setName(''); setUpdatedName(group.name);
      setNotice(create ? 'Grupo criado. Selecione as empresas.' : 'Grupo atualizado. Os acessos das empresas foram preservados.');
    } catch (e) {
      if (version === current.current) setError((e as Error).message);
    } finally { if (version === current.current) setBusy(false); }
  }

  async function rename() {
    if (!selected || !admin || editingLocked) return;
    const version = current.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const group = await api.current<Group>(`/groups/${selected.id}`, 'PATCH', { name: updatedName, expectedRevision: selected.revision });
      if (version !== current.current) return;
      setGroups(items => items.map(item => item.id === group.id ? group : item));
      setSelected(group); setUpdatedName(group.name); setIds(group.organizationIds);
      setNotice('Nome do grupo atualizado. Empresas e acessos preservados.');
    } catch (e) { if (version === current.current) setError((e as Error).message); }
    finally { if (version === current.current) setBusy(false); }
  }

  async function previewRemoval() {
    if (!selected || !admin || editingLocked) return;
    const version = current.current;
    setBusy(true); setError(''); setNotice(''); setDetachCompanies(false);
    try {
      const result = await api.current<RemovalPreview>(`/groups/${selected.id}/removal-preview`);
      if (version === current.current) setPreview(result);
    } catch (e) { if (version === current.current) setError((e as Error).message); }
    finally { if (version === current.current) setBusy(false); }
  }

  async function remove() {
    if (!preview || !admin || locked || (preview.organizations.length > 0 && !detachCompanies)) return;
    const version = current.current;
    setBusy(true); setError(''); setNotice('');
    try {
      await api.current(`/groups/${preview.id}`, 'DELETE', { expectedRevision: preview.revision, detachCompanies });
      if (version !== current.current) return;
      setGroups(items => items.filter(item => item.id !== preview.id));
      setSelected(null); setIds([]);
      setNotice('Grupo removido. As empresas e seus dados foram preservados.');
    } catch (e) { if (version === current.current) setError((e as Error).message); }
    finally {
      if (version === current.current) { setBusy(false); setPreview(null); setDetachCompanies(false); }
    }
  }

  return <section className="panel" aria-label="Grupos econômicos">
    <section aria-label="Como funcionam grupos e empresas">
      <h2>Como funcionam grupos e empresas</h2>
      <p><strong>Empresa:</strong> é uma organização (tenant) isolada. Caixas de entrada, contatos, automações, credenciais e limites pertencem a ela.</p>
      <p><strong>Grupo econômico:</strong> reúne empresas para organização administrativa. O grupo econômico não concede acesso nem compartilha dados entre elas.</p>
      <p><strong>Usuários e acessos:</strong> conceda o papel necessário em Usuários e acessos de cada empresa que a pessoa deve operar.</p>
    </section>
    <button className="button button--ghost" disabled={editingLocked} onClick={() => void load()}>Atualizar grupos</button>
    {error && <p className="notice notice--error" role="alert">{error} Atualize os grupos antes de tentar novamente.</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {busy && <p aria-live="polite">Carregando…</p>}
    {admin && <form onSubmit={event => { event.preventDefault(); void save(true); }}>
      <label htmlFor="economic-group-name">Nome do grupo</label>
      <input id="economic-group-name" value={name} maxLength={120} required disabled={editingLocked} onChange={event => setName(event.target.value)} />
      <button className="button button--primary" disabled={editingLocked || !name.trim()}>Criar grupo</button>
    </form>}
    <ul>{groups.map(group => <li key={group.id}>
      <button className="admin-text-link" disabled={editingLocked} aria-pressed={selected?.id === group.id} onClick={() => { setSelected(group); setUpdatedName(group.name); setIds(group.organizationIds); setNotice(''); setError('');setCompanyRemoval(false); }}>{group.name}</button>
    </li>)}</ul>
    {selected && admin && <form onSubmit={event => { event.preventDefault(); void rename(); }}>
      <label htmlFor="economic-group-updated-name">Novo nome do grupo</label>
      <input id="economic-group-updated-name" value={updatedName} maxLength={120} required disabled={editingLocked} onChange={event => setUpdatedName(event.target.value)} />
      <button className="button button--ghost" disabled={editingLocked || !updatedName.trim() || updatedName.trim() === selected.name}>Renomear grupo</button>
    </form>}
    {selected && <form onSubmit={event => { event.preventDefault(); void save(false); }}>
      <fieldset disabled={editingLocked || !admin}>
        <legend>Empresas de {selected.name}</legend>
        {companies.map(company => {
          const other = groups.find(group => group.id !== selected.id && group.organizationIds.includes(company.id));
          return <label key={company.id}>
            <input type="checkbox" checked={ids.includes(company.id)} disabled={!!other} onChange={event => setIds(values => event.target.checked ? [...values, company.id] : values.filter(id => id !== company.id))} />
            {company.name}{other ? ` — vinculada a ${other.name}` : ''}
          </label>;
        })}
      </fieldset>
      {admin && <button className="button button--primary" disabled={editingLocked}>Salvar empresas do grupo</button>}
    </form>}
    {admin&&<GroupCompanyRemovalLookup request={request} disabled={locked}/>}
    {selected && admin && <button className="button button--danger" disabled={editingLocked} onClick={() => void previewRemoval()}>Remover grupo</button>}
    {selected&&admin&&<button className="button button--danger" disabled={editingLocked} onClick={()=>setCompanyRemoval(value=>!value)}>{companyRemoval?'Fechar exclusão de empresas':'Excluir empresas deste grupo'}</button>}
    {selected&&admin&&companyRemoval&&<GroupCompanyRemoval groupId={selected.id} groupName={selected.name} request={request} disabled={editingLocked}/>}
    {preview && admin && <section role="dialog" aria-labelledby="economic-group-remove-title" className="panel">
      <h3 id="economic-group-remove-title">Remover somente o grupo</h3>
      <p>O agrupamento {preview.name} será removido. As empresas e seus dados serão preservados.</p>
      {preview.organizations.length > 0 ? <>
        <p>Estas empresas ficarão sem grupo:</p>
        <ul>{preview.organizations.map(company => <li key={company.id}>{company.name}</li>)}</ul>
        <label><input type="checkbox" checked={detachCompanies} disabled={locked} onChange={event => setDetachCompanies(event.target.checked)} />Preservar as empresas e deixá-las sem grupo</label>
      </> : <p>Este grupo não contém empresas.</p>}
      <p>Para excluir dados de uma empresa, abra a empresa em Empresas e use a exclusão com sua própria prévia.</p>
      <button className="button button--danger" disabled={locked || (preview.organizations.length > 0 && !detachCompanies)} onClick={() => void remove()}>Confirmar remoção do grupo</button>
      <button className="button button--ghost" disabled={locked} onClick={() => { setPreview(null); setDetachCompanies(false); }}>Cancelar remoção</button>
    </section>}
  </section>;
}
