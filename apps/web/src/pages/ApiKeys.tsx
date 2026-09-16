import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import type { ApiKey, IssueApiKeyRequest, IssuedApiKey } from "@jrc/contracts";
type ApiKeyScope = IssueApiKeyRequest['scopes'][number];

import { ApiClientError } from "../api/client.js";
import { IssuedKeyDialog } from "../api-keys/IssuedKeyDialog.js";
import { issueApiKey, listApiKeys, revokeApiKey } from "../api-keys/api.js";
import { toApiKeyMetadata } from "../api-keys/issued-key.js";
import { useApiClient, useSession } from "../auth/SessionProvider.js";

const scopeOptions: Array<{ value: ApiKeyScope; label: string }> = [
  { value: "instances:read", label: "Ler conexões" },
  { value: "instances:write", label: "Gerenciar conexões" },
  { value: "api_keys:manage", label: "Gerenciar chaves" },
];

function normalizedError(error: unknown, fallback: string) {
  const apiError = error instanceof ApiClientError ? error : null;
  return {
    text: apiError?.message ?? fallback,
    ...(apiError?.requestId ? { requestId: apiError.requestId } : {}),
  };
}

export function ApiKeysPage() {
  const client = useApiClient();
  const { session, tenantRevision } = useSession();
  const allowed =
    session?.activeOrganization.role === "OWNER" ||
    session?.activeOrganization.role === "ADMIN";
  const [items, setItems] = useState<ApiKey[]>([]);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiKeyScope[]>([]);
  const [issued, setIssued] = useState<IssuedApiKey | null>(null);
  const [loading, setLoading] = useState(allowed);
  const [submitting, setSubmitting] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [error, setError] = useState<{
    text: string;
    requestId?: string;
  } | null>(null);
  const tenantGeneration = useRef(0);
  const organizationId = session?.activeOrganization.id ?? null;

  const clearSecret = useCallback(() => setIssued(null), []);
  const resetTenantState = useCallback(() => {
    setItems([]);
    setName("");
    setScopes([]);
    setNextCursor(null);
    setHasNextPage(false);
    setError(null);
    clearSecret();
  }, [clearSecret]);
  const load = useCallback(
    async (
      cursor?: string,
      preserveError = false,
      generation = tenantGeneration.current,
    ) => {
      if (!allowed) return;
      setLoading(true);
      if (!preserveError) setError(null);
      try {
        const page = await listApiKeys(client, cursor);
        if (generation !== tenantGeneration.current) return;
        setItems((current) => {
          const combined = cursor ? [...current, ...page.data] : page.data;
          return [...new Map(combined.map((item) => [item.id, item])).values()];
        });
        setHasNextPage(page.pageInfo.hasNextPage);
        setNextCursor(page.pageInfo.nextCursor);
      } catch (caught) {
        if (generation === tenantGeneration.current && !preserveError) {
          setError(
            normalizedError(caught, "Não foi possível carregar as chaves."),
          );
        }
      } finally {
        if (generation === tenantGeneration.current) setLoading(false);
      }
    },
    [allowed, client],
  );

  useEffect(() => {
    const generation = ++tenantGeneration.current;
    resetTenantState();
    setLoading(allowed);
    if (allowed) void load(undefined, false, generation);
    const unregister = client.registerTenantPurge(() => {
      tenantGeneration.current += 1;
      resetTenantState();
      setLoading(false);
    });
    return () => {
      tenantGeneration.current += 1;
      resetTenantState();
      unregister();
    };
  }, [allowed, client, load, organizationId, resetTenantState, tenantRevision]);

  if (!allowed) {
    return (
      <section aria-labelledby="restricted-title">
        <p className="eyebrow">Chaves de API</p>
        <h1 id="restricted-title">Acesso restrito</h1>
        <p className="notice">
          Somente proprietários e administradores podem gerenciar chaves de API.
        </p>
      </section>
    );
  }

  const toggleScope = (scope: ApiKeyScope) => {
    setScopes((current) =>
      current.includes(scope)
        ? current.filter((candidate) => candidate !== scope)
        : [...current, scope],
    );
  };

  async function issue(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || scopes.length === 0) return;
    clearSecret();
    setSubmitting(true);
    setError(null);
    try {
      const result = await issueApiKey(client, {
        name: name.trim(),
        scopes,
        expiresAt: null,
      });
      setIssued(result);
      setItems((current) => [
        ...new Map(
          [toApiKeyMetadata(result), ...current].map((item) => [item.id, item]),
        ).values(),
      ]);
      setName("");
      setScopes([]);
    } catch (caught) {
      setError({
        ...normalizedError(caught, "Não foi possível emitir a chave."),
        text: "Não foi possível confirmar a emissão. Atualize a lista; se a chave existir, revogue-a e emita outra.",
      });
      void load(undefined, true);
    } finally {
      setSubmitting(false);
    }
  }

  async function revoke(key: ApiKey) {
    if (!window.confirm(`Revogar a chave “${key.name}”?`)) return;
    setError(null);
    try {
      await revokeApiKey(client, key.id);
      setItems((current) =>
        current.filter((candidate) => candidate.id !== key.id),
      );
    } catch (caught) {
      setError(normalizedError(caught, "Não foi possível revogar a chave."));
    }
  }

  return (
    <section aria-labelledby="api-keys-title">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Integrações JRC</p>
          <h1 id="api-keys-title">Chaves de API</h1>
          <p>
            Emita credenciais limitadas para integrações da organização ativa.
          </p>
        </div>
      </div>
      <section
        className="panel api-key-guide"
        aria-labelledby="api-key-guide-title"
      >
        <h2 id="api-key-guide-title">Como usar a chave JRC</h2>
        <p>
          A chave permite que outro sistema acesse as funções autorizadas desta
          empresa na API da JRC.
        </p>
        <p>
          O segredo completo aparece somente ao emitir a chave. A lista abaixo
          mostra o prefixo público para identificação. Se você não guardou o
          segredo, emita uma nova chave; após atualizar a integração, revogue a
          anterior.
        </p>
        <details>
          <summary>Exemplo de consulta e permissões disponíveis</summary>
          <p>
            Para consultar conexões, selecione “Ler conexões” e envie a chave
            completa no cabeçalho da requisição:
          </p>
          <pre>
            <code>
              {"GET /v1/instances?limit=20\nx-jrc-api-key: SUA_CHAVE_COMPLETA"}
            </code>
          </pre>
          <p>
            “Gerenciar conexões” permite operações nas conexões. “Gerenciar
            chaves” permite emitir e revogar credenciais da empresa; selecione
            apenas o necessário.
          </p>
        </details>
        <p>
          Os escopos atuais não habilitam envio de mensagens nem a integração
          com o JRC Conversa. Essa integração precisa de um conector próprio. A
          chave JRC também é diferente do token do Chatwoot e da autorização da
          Meta.
        </p>
      </section>
      {error ? (
        <div className="notice notice--error" role="alert">
          {error.text}
          {error.requestId ? (
            <small>Solicitação: {error.requestId}</small>
          ) : null}
        </div>
      ) : null}
      <form
        className="panel form-grid api-key-form"
        onSubmit={(event) => void issue(event)}
      >
        <label htmlFor="api-key-name">Nome da chave</label>
        <input
          id="api-key-name"
          maxLength={100}
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <fieldset>
          <legend>Escopos</legend>
          {scopeOptions.map((scope) => (
            <label key={scope.value} className="checkbox-row">
              <input
                type="checkbox"
                checked={scopes.includes(scope.value)}
                onChange={() => toggleScope(scope.value)}
              />
              {scope.label}
            </label>
          ))}
        </fieldset>
        <small>
          Preencha o nome e selecione pelo menos uma permissão para emitir a
          chave.
        </small>
        <button
          className="button button--primary"
          type="submit"
          disabled={submitting || !name.trim() || scopes.length === 0}
        >
          {submitting ? "Emitindo…" : "Emitir chave"}
        </button>
      </form>
      {loading ? (
        <div className="state-card" aria-busy="true">
          Carregando chaves…
        </div>
      ) : null}
      {!loading && items.length === 0 ? (
        <div className="state-card">
          <h2>Nenhuma chave emitida</h2>
          <p>Crie apenas as credenciais necessárias.</p>
        </div>
      ) : null}
      {items.length > 0 ? (
        <ul className="api-key-list">
          {items.map((key) => (
            <li key={key.id}>
              <div>
                <strong>{key.name}</strong>
                <span className="api-key-prefix-label">Prefixo público:</span>
                <code>{key.prefix}</code>
                <span>
                  {key.scopes
                    .map(
                      (scope) =>
                        scopeOptions.find((option) => option.value === scope)
                          ?.label ?? scope,
                    )
                    .join(" · ")}
                </span>
                <span>{key.revokedAt ? "Revogada" : "Ativa"}</span>
              </div>
              {key.revokedAt ? null : (
                <button
                  className="button button--danger"
                  type="button"
                  onClick={() => void revoke(key)}
                >
                  Revogar
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {hasNextPage && nextCursor ? (
        <button
          className="button button--ghost"
          type="button"
          onClick={() => void load(nextCursor)}
        >
          Carregar mais
        </button>
      ) : null}
      {issued ? (
        <IssuedKeyDialog secret={issued.secret} onClose={clearSecret} />
      ) : null}
    </section>
  );
}
