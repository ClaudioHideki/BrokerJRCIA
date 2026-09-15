import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { ProviderAccount } from "@jrc/contracts";
import { useApiClient, useSession } from "../auth/SessionProvider.js";
import { connectionAccountLabel } from "../broker/labels.js";
import {
  listBaileysProviderAccounts,
  createConnection,
} from "../connections/api.js";
import {
  parseProvisioningCsv,
  runProvisioningBatch,
  downloadCsv,
  type ProvisioningRow,
  type ProvisioningResult,
} from "../broker/import.js";
import { PageHeading } from "../broker/components.js";
import { Icon } from "../broker/Icon.js";
const labels = {
  WAITING: "Não iniciada",
  CREATED: "Criada",
  PENDING: "Em provisionamento",
  REVIEW: "Conferência necessária",
};
export function ProvisioningPage() {
  const client = useApiClient();
  const { session, tenantRevision } = useSession();
  const canCreate = session?.activeOrganization.role !== "VIEWER";
  const [step, setStep] = useState(1);
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [account, setAccount] = useState("");
  const [rows, setRows] = useState<ProvisioningRow[]>([]);
  const [results, setResults] = useState<ProvisioningResult[]>([]);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [running, setRunning] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [loadRevision, setLoadRevision] = useState(0);
  const generation = useRef(0);
  const stopped = useRef(false);
  const executing = useRef(false);
  const fileGeneration = useRef(0);
  useLayoutEffect(() => {
    const current = ++generation.current;
    stopped.current = false;
    executing.current = false;
    setStep(1);
    setAccounts([]);
    setAccount("");
    setRows([]);
    setResults([]);
    setError("");
    setRunning(false);
    setFileBusy(false);
    setAccountsLoading(true);
    setConfirmed(false);
    setFileName("");
    const purge = () => {
      generation.current++;
      fileGeneration.current++;
      stopped.current = true;
      setRows([]);
      setResults([]);
      setAccounts([]);
      setAccount("");
      setError("");
      setRunning(false);
      setStep(1);
    };
    const unregister = client.registerTenantPurge(purge);
    void listBaileysProviderAccounts(client)
      .then((page) => {
        if (current !== generation.current) return;
        setAccounts(page.data);
        setAccount(page.data[0]?.id ?? "");
      })
      .catch(() => {
        if (current === generation.current)
          setError("Não foi possível carregar as contas do provedor.");
      })
      .finally(() => {
        if (current === generation.current) setAccountsLoading(false);
      });
    return () => {
      purge();
      unregister();
    };
  }, [client, session?.activeOrganization.id, tenantRevision, loadRevision]);
  useLayoutEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);
  async function readFile(file: File | undefined) {
    if (!file || running) return;
    const current = generation.current;
    const reading = ++fileGeneration.current;
    setRows([]);
    setResults([]);
    setError("");
    setFileBusy(true);
    setConfirmed(false);
    setFileName(file.name);
    try {
      if (!/\.csv$/i.test(file.name) || file.size > 100_000)
        throw new Error("Selecione um CSV de até 100 KB.");
      const names = parseProvisioningCsv(await file.text());
      if (current === generation.current && reading === fileGeneration.current)
        setRows(names.map((name) => ({ name, key: crypto.randomUUID() })));
    } catch (e) {
      if (current === generation.current && reading === fileGeneration.current)
        setError(e instanceof Error ? e.message : "Falha na leitura.");
    } finally {
      if (current === generation.current && reading === fileGeneration.current)
        setFileBusy(false);
    }
  }
  async function execute() {
    if (
      executing.current ||
      !canCreate ||
      !confirmed ||
      !account ||
      !rows.length
    )
      return;
    executing.current = true;
    const current = generation.current;
    stopped.current = false;
    setRunning(true);
    setStep(5);
    setError("");
    await runProvisioningBatch(
      rows,
      (row) =>
        createConnection(
          client,
          { name: row.name, providerAccountId: account },
          row.key,
        ),
      () => !stopped.current && generation.current === current,
      (list) => {
        if (current === generation.current) setResults(list);
      },
    );
    if (current === generation.current) setRunning(false);
  }
  return (
    <section>
      <PageHeading
        title="Provisionamento em massa"
        description="Cadastre conexões JRC por QR Code a partir de um arquivo CSV."
      />
      {!canCreate ? (
        <div className="state-card">Seu acesso é somente leitura.</div>
      ) : (
        <>
          <ol className="wizard-steps">
            {[
              "Importar arquivo",
              "Revisar nomes",
              "Configurar",
              "Confirmar",
              "Acompanhar",
            ].map((label, i) => (
              <li
                key={label}
                className={
                  step === i + 1 ? "active" : step > i + 1 ? "complete" : ""
                }
              >
                <span>
                  {step > i + 1 ? <Icon name="check" size={14} /> : i + 1}
                </span>
                {label}
              </li>
            ))}
          </ol>
          {error ? (
            <div className="notice notice--error" role="alert">
              {error}
              {!accounts.length ? (
                <button
                  className="button button--ghost"
                  onClick={() => setLoadRevision((v) => v + 1)}
                >
                  Recarregar provedores
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="provision-layout">
            <section className="panel wizard-content">
              {step === 1 ? (
                <>
                  <h2>Importar conexões</h2>
                  <p>
                    Use uma linha por conexão e uma coluna chamada{" "}
                    <strong>nome</strong>.
                  </p>
                  <label className="upload-zone">
                    <Icon name="upload" size={40} />
                    <strong>
                      {fileName || "Selecione o arquivo da sua operação"}
                    </strong>
                    <span>CSV · até 100 nomes · máximo 100 KB</span>
                    <input
                      aria-label="Arquivo CSV"
                      type="file"
                      accept=".csv,text/csv"
                      onChange={(e) => void readFile(e.target.files?.[0])}
                    />
                  </label>
                  {fileBusy ? (
                    <p role="status">Lendo arquivo…</p>
                  ) : rows.length ? (
                    <p role="status">
                      {rows.length} nomes válidos encontrados.
                    </p>
                  ) : null}
                  <button
                    className="text-button"
                    onClick={() =>
                      downloadCsv("modelo-conexoes-jrc.csv", [
                        ["nome"],
                        ["Comercial - Matriz"],
                        ["Suporte - Filial"],
                      ])
                    }
                  >
                    Baixar modelo CSV
                  </button>
                  <div className="wizard-actions">
                    <button
                      className="button button--primary"
                      disabled={!rows.length || fileBusy}
                      onClick={() => setStep(2)}
                    >
                      Revisar nomes <Icon name="arrow" />
                    </button>
                  </div>
                </>
              ) : null}
              {step === 2 ? (
                <>
                  <h2>Confira os nomes</h2>
                  <p>
                    A coluna nome foi reconhecida. As demais colunas não serão
                    importadas.
                  </p>
                  <div className="table-scroll import-preview">
                    <table className="broker-table">
                      <thead>
                        <tr>
                          <th>Linha</th>
                          <th>Nome da conexão</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r, i) => (
                          <tr key={r.key}>
                            <td>{i + 1}</td>
                            <td>{r.name}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="wizard-actions">
                    <button
                      className="button button--ghost"
                      onClick={() => setStep(1)}
                    >
                      Voltar
                    </button>
                    <button
                      className="button button--primary"
                      onClick={() => setStep(3)}
                    >
                      Configurar <Icon name="arrow" />
                    </button>
                  </div>
                </>
              ) : null}
              {step === 3 ? (
                <>
                  <h2>Selecione a conta JRC</h2>
                  <div className="form-grid">
                    <label htmlFor="bulk-account">Conta JRC</label>
                    <select
                      id="bulk-account"
                      value={account}
                      onChange={(e) => setAccount(e.target.value)}
                    >
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {connectionAccountLabel(a.name)}
                        </option>
                      ))}
                    </select>
                  </div>
                  {accountsLoading ? (
                    <p role="status">Carregando contas…</p>
                  ) : !accounts.length ? (
                    <p>
                      Nenhuma conta JRC disponível. Solicite a configuração à
                      administração JRC.
                    </p>
                  ) : null}
                  <p>
                    O cadastro respeita o limite de conexões da empresa e exige
                    um nome ainda não utilizado.
                  </p>
                  <div className="wizard-actions">
                    <button
                      className="button button--ghost"
                      onClick={() => setStep(2)}
                    >
                      Voltar
                    </button>
                    <button
                      className="button button--primary"
                      disabled={!account || accountsLoading}
                      onClick={() => setStep(4)}
                    >
                      Revisar cadastro <Icon name="arrow" />
                    </button>
                  </div>
                </>
              ) : null}
              {step === 4 ? (
                <>
                  <h2>Tudo pronto para cadastrar</h2>
                  <div className="review-summary">
                    <strong>{rows.length}</strong>
                    <span>conexões em {session?.activeOrganization.name}</span>
                  </div>
                  <p>
                    Provedor: {accounts.find((a) => a.id === account)?.name}.
                    Cada conexão precisará ser pareada individualmente após o
                    provisionamento.
                  </p>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    Conferi os nomes e a empresa de destino.
                  </label>
                  <div className="wizard-actions">
                    <button
                      className="button button--ghost"
                      onClick={() => setStep(3)}
                    >
                      Voltar
                    </button>
                    <button
                      className="button button--primary"
                      disabled={!confirmed}
                      onClick={() => void execute()}
                    >
                      Criar {rows.length} conexões
                    </button>
                  </div>
                </>
              ) : null}
              {step === 5 ? (
                <>
                  <h2>
                    {running ? "Cadastrando conexões…" : "Resultado do lote"}
                  </h2>
                  <p role="status">
                    {results.filter((r) => r.state !== "WAITING").length} de{" "}
                    {rows.length} processadas.
                  </p>
                  <div className="table-scroll">
                    <table className="broker-table">
                      <thead>
                        <tr>
                          <th>Conexão</th>
                          <th>Resultado</th>
                          <th>Detalhes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.map((r) => (
                          <tr key={r.key}>
                            <td>{r.name}</td>
                            <td>{labels[r.state]}</td>
                            <td>
                              {r.instanceId ? (
                                <Link to={"/conexoes/" + r.instanceId}>
                                  Abrir →
                                </Link>
                              ) : (
                                "—"
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {results.some((r) => r.state === "REVIEW") ? (
                    <p className="notice">
                      Lote interrompido: houve falha ou não foi possível
                      confirmar uma criação. Confira a lista de conexões antes
                      de importar novamente para evitar duplicações.
                    </p>
                  ) : null}
                  <div className="wizard-actions">
                    {running ? (
                      <button
                        className="button button--ghost"
                        onClick={() => {
                          stopped.current = true;
                        }}
                      >
                        Parar após esta criação
                      </button>
                    ) : (
                      <>
                        <button
                          className="button button--ghost"
                          onClick={() =>
                            downloadCsv("resultado-provisionamento-jrc.csv", [
                              ["Nome", "Resultado", "ID", "Chave idempotente"],
                              ...results.map((r) => [
                                r.name,
                                labels[r.state],
                                r.instanceId ?? "",
                                r.key,
                              ]),
                            ])
                          }
                        >
                          Exportar resultado
                        </button>
                        <Link className="button button--primary" to="/conexoes">
                          Ver conexões
                        </Link>
                      </>
                    )}
                  </div>
                </>
              ) : null}
            </section>
            <aside className="panel provision-help">
              <span className="quick-icon">
                <Icon name="upload" />
              </span>
              <h2>O que será feito</h2>
              <ul>
                {[
                  "Validar nomes do arquivo",
                  "Usar a empresa ativa",
                  "Cadastrar no provedor escolhido",
                  "Aplicar os limites da conta",
                  "Exibir o resultado por conexão",
                ].map((t) => (
                  <li key={t}>
                    <Icon name="check" size={16} />
                    {t}
                  </li>
                ))}
              </ul>
              <hr />
              <h3>Durante o cadastro</h3>
              <p>
                Mantenha esta página aberta. O lote é executado nesta sessão; ao
                sair, as próximas criações param. Uma criação já iniciada pode
                concluir.
              </p>
              <p>
                O cadastro não associa números, filas, templates ou webhooks
                automaticamente.
              </p>
            </aside>
          </div>
        </>
      )}
    </section>
  );
}
