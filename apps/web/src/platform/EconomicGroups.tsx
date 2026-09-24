import { useEffect, useRef, useState } from 'react';

interface Group { id: string; name: string; revision: number; organizationIds: string[] }
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const current = useRef(0);
  const api = useRef(request);
  api.current = request;
  const locked = disabled || busy;

  async function load() {
    const version = ++current.current;
    setBusy(true); setError(''); setNotice(''); setSelected(null);
    try {
      const result = await api.current<{ data: Group[] }>('/groups');
      if (version === current.current) setGroups(result.data);
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
      setSelected(group); setIds(group.organizationIds); setName('');
      setNotice(create ? 'Grupo criado. Selecione as empresas.' : 'Grupo atualizado. Os acessos das empresas foram preservados.');
    } catch (e) {
      if (version === current.current) setError((e as Error).message);
    } finally { if (version === current.current) setBusy(false); }
  }

  return <section className="panel" aria-label="Grupos econômicos">
    <p>O grupo organiza empresas. Cada empresa mantém suas caixas, contatos, automações e permissões independentes.</p>
    <button className="button button--ghost" disabled={locked} onClick={() => void load()}>Atualizar grupos</button>
    {error && <p className="notice notice--error" role="alert">{error} Atualize os grupos antes de tentar novamente.</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {busy && <p aria-live="polite">Carregando…</p>}
    {admin && <form onSubmit={event => { event.preventDefault(); void save(true); }}>
      <label htmlFor="economic-group-name">Nome do grupo</label>
      <input id="economic-group-name" value={name} maxLength={120} required disabled={locked} onChange={event => setName(event.target.value)} />
      <button className="button button--primary" disabled={locked || !name.trim()}>Criar grupo</button>
    </form>}
    <ul>{groups.map(group => <li key={group.id}>
      <button className="admin-text-link" disabled={locked} aria-pressed={selected?.id === group.id} onClick={() => { setSelected(group); setIds(group.organizationIds); setNotice(''); setError(''); }}>{group.name}</button>
    </li>)}</ul>
    {selected && <form onSubmit={event => { event.preventDefault(); void save(false); }}>
      <fieldset disabled={locked || !admin}>
        <legend>Empresas de {selected.name}</legend>
        {companies.map(company => {
          const other = groups.find(group => group.id !== selected.id && group.organizationIds.includes(company.id));
          return <label key={company.id}>
            <input type="checkbox" checked={ids.includes(company.id)} disabled={!!other} onChange={event => setIds(values => event.target.checked ? [...values, company.id] : values.filter(id => id !== company.id))} />
            {company.name}{other ? ` — vinculada a ${other.name}` : ''}
          </label>;
        })}
      </fieldset>
      {admin && <button className="button button--primary" disabled={locked}>Salvar empresas do grupo</button>}
    </form>}
  </section>;
}
