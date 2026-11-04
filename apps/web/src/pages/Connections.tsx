import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";

import type { Instance, InstanceStatus } from "@jrc/contracts";

import { ApiClientError } from "../api/client.js";
import { useApiClient, useSession } from "../auth/SessionProvider.js";
import { listConnections } from "../connections/api.js";
import { ConnectionStatus } from "../connections/components/ConnectionStatus.js";
import { connectionStatusView } from "../connections/status.js";
import "../connections/components/instance-workspace.css";
import { Metric } from "../broker/components.js";
import { Icon } from "../broker/Icon.js";
import { downloadCsv } from "../broker/import.js";
import {collectNameSearchPages,matchesConnectionName} from '../connections/name-search.js';
import {useCompleteNameSearch} from '../connections/useCompleteNameSearch.js';

function errorMessage(error: unknown) {
  if (!(error instanceof ApiClientError))
    return { text: "Não foi possível carregar as conexões." };
  return {
    text: error.message,
    ...(error.requestId ? { requestId: error.requestId } : {}),
  };
}

export function ConnectionsPage() {
  const client = useApiClient();
  const { session, tenantRevision } = useSession();
  const [items, setItems] = useState<Instance[]>([]);
  const [search, setSearch] = useState("");
  const [searchVersion,setSearchVersion]=useState(0);
  const nameInput=useRef<HTMLInputElement>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [error, setError] = useState<{
    text: string;
    requestId?: string;
  } | null>(null);
  const loadGeneration = useRef(0);
  const tenantId = session?.activeOrganization.id ?? "";
  const searchActive=Boolean(search.trim());
  const loadSearch=useCallback((signal:AbortSignal)=>collectNameSearchPages(async(cursor,abort)=>{
    const page=await listConnections(client,cursor,{limit:100,signal:abort});
    if(page.pageInfo.hasNextPage&&!page.pageInfo.nextCursor)throw new Error('Invalid pagination');
    return {data:page.data,nextCursor:page.pageInfo.hasNextPage?page.pageInfo.nextCursor:null};
  },signal),[client]);
  const nameSearch=useCompleteNameSearch(searchActive&&!loading,`${tenantId}:${tenantRevision}:${searchVersion}`,loadSearch);

  const load = useCallback(
    async (cursor?: string, generation = loadGeneration.current) => {
      cursor ? setLoadingMore(true) : setLoading(true);
      if(!cursor)setSearchVersion(value=>value+1);
      setError(null);
      try {
        const page = await listConnections(client, cursor);
        if (generation !== loadGeneration.current) return;
        setItems((current) => {
          const combined = cursor ? [...current, ...page.data] : page.data;
          return [...new Map(combined.map((item) => [item.id, item])).values()];
        });
        setHasNextPage(page.pageInfo.hasNextPage);
        setNextCursor(page.pageInfo.nextCursor);
      } catch (caught) {
        if (generation !== loadGeneration.current) return;
        setError(errorMessage(caught));
      } finally {
        if (generation === loadGeneration.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [client],
  );

  useLayoutEffect(() => {
    const generation = ++loadGeneration.current;
    setItems([]);
    setSearch("");
    setStatusFilter("");
    setNextCursor(null);
    setHasNextPage(false);
    setError(null);
    setLoading(true);
    setLoadingMore(false);
    const unregister = client.registerTenantPurge(() => {
      loadGeneration.current += 1;
      setItems([]);
      setSearch("");
      setStatusFilter("");
      setNextCursor(null);
      setHasNextPage(false);
      setError(null);
      setLoading(true);
      setLoadingMore(false);
    });
    void load(undefined, generation);
    return () => {
      if (loadGeneration.current === generation) loadGeneration.current += 1;
      unregister();
    };
  }, [client, load, tenantId, tenantRevision]);

  const canMutate = session?.activeOrganization.role !== "VIEWER";
  const visibleItems=searchActive?nameSearch.items:items;
  const filtered = visibleItems.filter(
    (item) =>
      matchesConnectionName(item.name,search) &&
      (!statusFilter || item.status === statusFilter),
  );
  return (
    <section aria-labelledby="connections-title">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Operação WhatsApp</p>
          <h1 id="connections-title">Conexões</h1>
          <p>Gerencie as conexões WhatsApp da organização ativa.</p>
        </div>
        <div className="heading-actions">
          {visibleItems.length ? (
            <button
              className="button button--ghost"
              onClick={() =>
                downloadCsv("jrc-conexoes-carregadas.csv", [
                  ["Nome", "Tipo de conexão", "Status", "Criada em"],
                  ...filtered.map((i) => [
                    i.name,
                    i.provider === "META"
                      ? "WhatsApp Oficial"
                      : "WhatsApp Business por QR Code",
                    connectionStatusView(i.status).label,
                    i.createdAt,
                  ]),
                ])
              }
            >
              Exportar CSV
            </button>
          ) : null}
          {canMutate ? (
            <>
              <Link className="button button--ghost" to="/provisionamento">
                <Icon name="upload" size={15} />
                Importar
              </Link>
              <Link className="button button--primary" to="/legacy/conexoes/nova">
                <Icon name="plus" size={15} />
                Nova conexão
              </Link>
            </>
          ) : null}
        </div>
      </div>

      {!canMutate ? (
        <p className="notice">Seu acesso é somente leitura.</p>
      ) : null}
      {loading ? (
        <div className="state-card" aria-busy="true">
          Carregando conexões…
        </div>
      ) : null}
      {error ? (
        <div className="notice notice--error" role="alert">
          {error.text}
          {error.requestId ? (
            <small>Solicitação: {error.requestId}</small>
          ) : null}
          <button
            className="button button--ghost"
            type="button"
            onClick={() => void load()}
          >
            Tentar novamente
          </button>
        </div>
      ) : null}
      {!searchActive&&!loading && !error && items.length === 0 ? (
        <div className="state-card">
          <h2>Nenhuma conexão criada</h2>
          <p>Quando uma conexão for criada, ela aparecerá aqui.</p>
        </div>
      ) : null}
      {visibleItems.length > 0 ? (
        <div className="metric-grid metric-grid--four">
          <Metric
            label="Conexões carregadas"
            value={String(visibleItems.length)}
            note={
              !searchActive&&hasNextPage ? "Lista parcial · há mais páginas" : "Lista completa"
            }
            icon="connections"
          />
          <Metric
            label="Conectadas"
            value={String(visibleItems.filter((i) => i.status === "CONNECTED").length)}
            note="Nesta lista"
            tone="green"
            icon="check"
          />
          <Metric
            label="Precisam de atenção"
            value={String(
              visibleItems.filter((i) =>
                ["ERROR", "PROVISIONING_FAILED", "AWAITING_ACTION"].includes(
                  i.status,
                ),
              ).length,
            )}
            note="Nesta lista"
            tone="amber"
            icon="health"
          />
          <Metric
            label="Desconectadas"
            value={String(
              visibleItems.filter((i) => i.status === "DISCONNECTED").length,
            )}
            note="Nesta lista"
            tone="red"
            icon="connections"
          />
        </div>
      ) : null}
      {(
        <div className="connection-filters">
          <label>
            Buscar conexão
            <input
              ref={nameInput}
              type="search"
              maxLength={100}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Nome da conexão"
            />
          </label>
          {search&&<button type="button" className="button button--secondary" onClick={()=>{setSearch('');nameInput.current?.focus();}}>Limpar busca de conexões</button>}
          <label>
            Filtrar por status
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">Todos os status</option>
              {(
                [
                  "PROVISIONING",
                  "CREATED",
                  "PROVISIONING_FAILED",
                  "CONNECTING",
                  "AWAITING_ACTION",
                  "CONNECTED",
                  "DISCONNECTING",
                  "DISCONNECTED",
                  "ERROR",
                ] as InstanceStatus[]
              ).map((status) => (
                <option key={status} value={status}>
                  {connectionStatusView(status).label}
                </option>
              ))}
            </select>
          </label>
          {!searchActive&&<p>
            Filtros aplicados às conexões carregadas: {filtered.length} de{" "}
            {items.length}.
            {hasNextPage ? " Carregue mais para ampliar os resultados." : ""}
          </p>}
          {searchActive&&nameSearch.status!=='READY'&&nameSearch.status!=='ERROR'&&<p role="status">Buscando por nome em todas as páginas…</p>}
          {searchActive&&nameSearch.status==='READY'&&<p role="status" aria-label="Resultados da busca">{filtered.length} de {visibleItems.length} conexões · busca completa por nome e status.</p>}
          {searchActive&&nameSearch.status==='ERROR'&&<div role="alert" aria-label="Erro da busca"><p>Não foi possível concluir a busca em todas as páginas. Os resultados não estão completos.</p><button type="button" className="button button--secondary" onClick={nameSearch.retry}>Tentar busca novamente</button></div>}
        </div>
      )}
      {(searchActive?nameSearch.status==='READY':items.length>0) && filtered.length === 0 ? (
        <p className="state-card">Nenhuma conexão corresponde aos filtros.</p>
      ) : null}
      {filtered.length > 0 ? (
        <div className="panel connection-table table-scroll">
          <table className="broker-table">
            <thead>
              <tr>
                <th>Conexão</th>
                <th>Tipo</th>
                <th>Conexão</th>
                <th>Status</th>
                <th>Criada em</th>
                <th>Detalhes</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((instance) => (
                <tr key={instance.id}>
                  <td>
                    <Link
                      className="connection-name"
                      to={`/legacy/conexoes/${instance.id}`}
                      aria-label={`${instance.name}, ver detalhes`}
                    >
                      <span className="connection-avatar">
                        <Icon name="messages" size={17} />
                      </span>
                      <strong>{instance.name}</strong>
                    </Link>
                  </td>
                  <td>
                    {instance.provider === "META"
                      ? "WhatsApp oficial"
                      : "WhatsApp Business"}
                  </td>
                  <td>
                    {instance.provider === "META" ? "API oficial" : "QR Code"}
                  </td>
                  <td>
                    <ConnectionStatus status={instance.status} />
                  </td>
                  <td>
                    {new Date(instance.createdAt).toLocaleDateString("pt-BR")}
                  </td>
                  <td>
                    <Icon name="arrow" size={16} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {!searchActive&&hasNextPage && nextCursor ? (
        <button
          className="button button--ghost"
          type="button"
          disabled={loadingMore}
          onClick={() => void load(nextCursor)}
        >
          {loadingMore ? "Carregando…" : "Carregar mais"}
        </button>
      ) : null}
    </section>
  );
}
