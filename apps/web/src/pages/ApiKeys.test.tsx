// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CONSOLE_ORGANIZATION_SWITCH_REJECTED_CODE } from "@jrc/contracts";

import type { ApiClient } from "../api/client.js";
import { ApiClientError } from "../api/client.js";
import { App } from "../app/App.js";

const ORG = "92776cb0-bcba-45c0-98a3-2937fefdfdaf";
const ORG_B = "11111111-2222-4333-8444-555555555555";
const ID = "81555d45-b1a2-4a3f-ab95-c1459b0df0d0";
const SECRET = "jrc_prefix123_abcdefghijklmnopqrstuvwxyzABCDEFGH012345678";
const now = "2030-01-01T12:00:00.000Z";
const apiKey = {
  id: ID,
  name: "Automação",
  prefix: "prefix123",
  scopes: ["instances:read"],
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  createdAt: now,
};
const issuedApiKey = {
  id: ID,
  name: "Automação",
  prefix: "prefix123",
  scopes: ["instances:read"],
  expiresAt: null,
  createdAt: now,
  secret: SECRET,
};

function session(role: "OWNER" | "ADMIN" | "OPERATOR" | "VIEWER") {
  const activeOrganization = {
    id: ORG,
    name: "JRC Matriz",
    slug: "jrc-matriz",
    role,
  };
  return {
    accessToken: "memory-only-canary",
    tokenType: "Bearer" as const,
    expiresIn: 600,
    user: {
      id: "8e757fb4-18ff-4c20-841b-19f282ece546",
      email: "owner@example.test",
    },
    activeOrganization,
    organizations: [activeOrganization],
  };
}

function client(
  request: ApiClient["request"],
  role: "OWNER" | "ADMIN" | "OPERATOR" | "VIEWER" = "OWNER",
  purge?: (handler: () => void) => () => void,
): ApiClient {
  return {
    restore: vi.fn(async () => session(role)),
    request,
    login: vi.fn(),
    selectOrganization: vi.fn(),
    switchOrganization: vi.fn(),
    logout: vi.fn(),
    registerTenantPurge: vi.fn(purge ?? (() => () => undefined)),
    subscribeToSessionExpiration: vi.fn(() => () => undefined),
  } as unknown as ApiClient;
}

function switchingClient(
  request: ApiClient["request"],
  options: { rejectSwitch?: boolean } = {},
): ApiClient {
  const organizations = [
    { id: ORG, name: "JRC Matriz", slug: "jrc-matriz", role: "OWNER" as const },
    {
      id: ORG_B,
      name: "JRC Filial",
      slug: "jrc-filial",
      role: "OWNER" as const,
    },
  ];
  const purgeHandlers = new Set<() => void>();
  const browserSession = (
    activeOrganization: (typeof organizations)[number],
  ) => ({
    user: {
      id: "8e757fb4-18ff-4c20-841b-19f282ece546",
      email: "owner@example.test",
    },
    activeOrganization,
    organizations,
  });
  return {
    restore: vi.fn(async () => browserSession(organizations[0]!)),
    switchOrganization: vi.fn(async ({ organizationId }) => {
      for (const purge of [...purgeHandlers]) purge();
      if (options.rejectSwitch) {
        throw new ApiClientError(
          "Não foi possível trocar de organização. Sua sessão atual foi mantida.",
          409,
          undefined,
          CONSOLE_ORGANIZATION_SWITCH_REJECTED_CODE,
        );
      }
      return browserSession(
        organizations.find(({ id }) => id === organizationId)!,
      );
    }),
    request,
    login: vi.fn(),
    selectOrganization: vi.fn(),
    logout: vi.fn(),
    registerTenantPurge: vi.fn((handler: () => void) => {
      purgeHandlers.add(handler);
      return () => purgeHandlers.delete(handler);
    }),
    subscribeToSessionExpiration: vi.fn(() => () => undefined),
  } as unknown as ApiClient;
}

describe("ApiKeysPage", () => {
  it("explains the public prefix, one-time secret and supported API usage", async () => {
    const request = vi.fn(async () => ({
      data: [apiKey],
      pageInfo: { hasNextPage: false, nextCursor: null },
    })) as ApiClient["request"];
    render(<App client={client(request)} initialEntries={["/chaves-api"]} />);
    await screen.findByText("Automação");
    expect(
      screen.getByRole("heading", { name: "Como usar a chave JRC" }),
    ).toBeVisible();
    expect(screen.getByText("Prefixo público:")).toBeVisible();
    expect(
      screen.getByText(/O segredo completo aparece somente ao emitir a chave/),
    ).toBeVisible();
    fireEvent.click(
      screen.getByText("Exemplo de consulta e permissões disponíveis"),
    );
    expect(screen.getByText(/x-jrc-api-key: SUA_CHAVE_COMPLETA/)).toBeVisible();
    expect(
      screen.getByText(
        /não habilitam envio de mensagens nem a integração com o JRC Conversa/,
      ),
    ).toBeVisible();
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });
  it("lista, pagina e revoga com confirmação", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return undefined;
      if (path.includes("cursor=next"))
        return {
          data: [
            {
              ...apiKey,
              id: "69b1e411-4cb8-43bc-a8c0-b8ee3277aba3",
              name: "Integração",
            },
          ],
          pageInfo: { hasNextPage: false, nextCursor: null },
        };
      return {
        data: [apiKey],
        pageInfo: { hasNextPage: true, nextCursor: "next" },
      };
    }) as ApiClient["request"];
    render(<App client={client(request)} initialEntries={["/chaves-api"]} />);
    expect(await screen.findByText("Automação")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Carregar mais" }));
    expect(await screen.findByText("Integração")).toBeVisible();
    fireEvent.click(screen.getAllByRole("button", { name: "Revogar" })[0]!);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(`/v1/api-keys/${ID}`, {
        method: "DELETE",
      }),
    );
    expect(screen.queryByText("Automação")).not.toBeInTheDocument();
  });

  it("revela o segredo uma vez, copia somente por ação e limpa ao fechar", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const request = vi.fn(async (_path: string, init?: RequestInit) =>
      init?.method === "POST"
        ? issuedApiKey
        : { data: [], pageInfo: { hasNextPage: false, nextCursor: null } },
    ) as ApiClient["request"];
    render(<App client={client(request)} initialEntries={["/chaves-api"]} />);
    await screen.findByText("Nenhuma chave emitida");
    fireEvent.change(screen.getByLabelText("Nome da chave"), {
      target: { value: "Automação" },
    });
    fireEvent.click(screen.getByLabelText("Ler conexões"));
    const issueButton = screen.getByRole("button", { name: "Emitir chave" });
    issueButton.focus();
    fireEvent.click(issueButton);
    expect(
      await screen.findByRole("dialog", { name: "Chave emitida" }),
    ).toHaveTextContent(SECRET);
    const copyButton = screen.getByRole("button", { name: "Copiar chave" });
    const closeButton = screen.getByRole("button", { name: "Fechar" });
    const secretValue = screen.getByLabelText("Chave secreta emitida");
    await waitFor(() => expect(copyButton).toHaveFocus());
    closeButton.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(secretValue).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(closeButton).toHaveFocus();
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(copyButton);
    expect(writeText).toHaveBeenCalledWith(SECRET);
    fireEvent.click(closeButton);
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Nome da chave")).toHaveFocus();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("informa falha do clipboard e permite cópia manual", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("clipboard denied");
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const request = vi.fn(async (_path: string, init?: RequestInit) =>
      init?.method === "POST"
        ? issuedApiKey
        : { data: [], pageInfo: { hasNextPage: false, nextCursor: null } },
    ) as ApiClient["request"];
    render(<App client={client(request)} initialEntries={["/chaves-api"]} />);
    await screen.findByText("Nenhuma chave emitida");
    fireEvent.change(screen.getByLabelText("Nome da chave"), {
      target: { value: "Automação" },
    });
    fireEvent.click(screen.getByLabelText("Ler conexões"));
    fireEvent.click(screen.getByRole("button", { name: "Emitir chave" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Copiar chave" }),
    );

    expect(await screen.findByText(/não foi possível copiar/i)).toBeVisible();
    expect(screen.getByText(SECRET)).toHaveAttribute("tabindex", "0");
  });

  it("limpa segredo no purge de tenant e Escape", async () => {
    let purge: (() => void) | undefined;
    const request = vi.fn(async (_path: string, init?: RequestInit) =>
      init?.method === "POST"
        ? issuedApiKey
        : { data: [], pageInfo: { hasNextPage: false, nextCursor: null } },
    ) as ApiClient["request"];
    render(
      <App
        client={client(request, "ADMIN", (handler) => {
          purge = handler;
          return () => {
            purge = undefined;
          };
        })}
        initialEntries={["/chaves-api"]}
      />,
    );
    await screen.findByText("Nenhuma chave emitida");
    fireEvent.change(screen.getByLabelText("Nome da chave"), {
      target: { value: "Automação" },
    });
    fireEvent.click(screen.getByLabelText("Ler conexões"));
    fireEvent.click(screen.getByRole("button", { name: "Emitir chave" }));
    await screen.findByText(SECRET);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Copiar chave" }),
      ).toHaveFocus(),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByText(SECRET)).not.toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("Nome da chave"), {
      target: { value: "Automação 2" },
    });
    fireEvent.click(screen.getByLabelText("Ler conexões"));
    fireEvent.click(screen.getByRole("button", { name: "Emitir chave" }));
    await screen.findByText(SECRET);
    act(() => purge?.());
    await waitFor(() =>
      expect(screen.queryByText(SECRET)).not.toBeInTheDocument(),
    );
  });

  it("limpa formulário e metadados e recarrega a lista ao trocar de tenant", async () => {
    let listCalls = 0;
    const request = vi.fn(async (path: string) => {
      if (!path.startsWith("/v1/api-keys?"))
        throw new Error(`unexpected ${path}`);
      listCalls += 1;
      return {
        data: [
          {
            ...apiKey,
            id: listCalls === 1 ? ID : "69b1e411-4cb8-43bc-a8c0-b8ee3277aba3",
            name: listCalls === 1 ? "Chave Matriz" : "Chave Filial",
          },
        ],
        pageInfo: { hasNextPage: false, nextCursor: null },
      };
    }) as ApiClient["request"];
    render(
      <App
        client={switchingClient(request)}
        initialEntries={["/chaves-api"]}
      />,
    );
    expect(await screen.findByText("Chave Matriz")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Nome da chave"), {
      target: { value: "Não pode vazar" },
    });
    fireEvent.click(screen.getByLabelText("Ler conexões"));

    fireEvent.change(screen.getByLabelText("Organização ativa"), {
      target: { value: ORG_B },
    });

    expect(await screen.findByText("Chave Filial")).toBeVisible();
    expect(screen.queryByText("Chave Matriz")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Nome da chave")).toHaveValue("");
    expect(screen.getByLabelText("Ler conexões")).not.toBeChecked();
    expect(listCalls).toBe(2);
  });

  it("recarrega as chaves do tenant de origem quando a troca é rejeitada", async () => {
    let listCalls = 0;
    const request = vi.fn(async (path: string) => {
      if (!path.startsWith("/v1/api-keys?"))
        throw new Error(`unexpected ${path}`);
      listCalls += 1;
      return {
        data: [apiKey],
        pageInfo: { hasNextPage: false, nextCursor: null },
      };
    }) as ApiClient["request"];
    render(
      <App
        client={switchingClient(request, { rejectSwitch: true })}
        initialEntries={["/chaves-api"]}
      />,
    );
    expect(await screen.findByText("Automação")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Nome da chave"), {
      target: { value: "Não pode vazar" },
    });

    fireEvent.change(screen.getByLabelText("Organização ativa"), {
      target: { value: ORG_B },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "sessão atual foi mantida",
    );
    await waitFor(() => expect(listCalls).toBe(2));
    expect(screen.getByText("Automação")).toBeVisible();
    expect(screen.getByLabelText("Nome da chave")).toHaveValue("");
    expect(screen.queryByText("Carregando chaves…")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Organização ativa")).toHaveValue(ORG);
  });

  it.each(["OPERATOR", "VIEWER"] as const)(
    "mantém %s sem acesso ao gerenciamento",
    async (role) => {
      const request = vi.fn() as ApiClient["request"];
      render(
        <App client={client(request, role)} initialEntries={["/chaves-api"]} />,
      );
      expect(
        await screen.findByRole("heading", { name: "Acesso restrito" }),
      ).toBeVisible();
      expect(
        screen.getByText(/somente proprietários e administradores/i),
      ).toBeVisible();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("preserva orientação e request ID quando a resposta de emissão pode ter sido perdida", async () => {
    let listCalls = 0;
    let issueCalls = 0;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/v1/api-keys?")) {
        listCalls += 1;
        return {
          data: listCalls === 1 ? [] : [apiKey],
          pageInfo: { hasNextPage: false, nextCursor: null },
        };
      }
      if (path === "/v1/api-keys" && init?.method === "POST") {
        issueCalls += 1;
        throw new ApiClientError(
          "Serviço temporariamente indisponível. Tente novamente.",
          503,
          "85a17103-9f0d-4d86-b55d-4184597e17a8",
        );
      }
      throw new Error(`unexpected ${path}`);
    }) as ApiClient["request"];
    render(<App client={client(request)} initialEntries={["/chaves-api"]} />);
    await screen.findByText("Nenhuma chave emitida");
    fireEvent.change(screen.getByLabelText("Nome da chave"), {
      target: { value: "Automação" },
    });
    fireEvent.click(screen.getByLabelText("Ler conexões"));
    fireEvent.click(screen.getByRole("button", { name: "Emitir chave" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/não foi possível confirmar a emissão/i);
    expect(alert).toHaveTextContent(/revogue-a e emita outra/i);
    expect(alert).toHaveTextContent("85a17103-9f0d-4d86-b55d-4184597e17a8");
    expect(await screen.findByText("Automação")).toBeVisible();
    expect(issueCalls).toBe(1);
    expect(listCalls).toBe(2);
  });

  it("mostra indisponibilidade e request ID ao falhar a listagem", async () => {
    const request = vi.fn(async () => {
      throw new ApiClientError(
        "Serviço temporariamente indisponível. Tente novamente.",
        503,
        "fbd7746d-bd99-43ae-8a1d-d283dd92b70b",
      );
    }) as ApiClient["request"];
    render(<App client={client(request)} initialEntries={["/chaves-api"]} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Serviço temporariamente indisponível");
    expect(alert).toHaveTextContent("fbd7746d-bd99-43ae-8a1d-d283dd92b70b");
  });

  it("mantém a chave e mostra request ID quando a revogação falha", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        throw new ApiClientError(
          "Serviço temporariamente indisponível. Tente novamente.",
          503,
          "37d2e3ba-5920-4947-93ab-f9f905a78524",
        );
      }
      return {
        data: [apiKey],
        pageInfo: { hasNextPage: false, nextCursor: null },
      };
    }) as ApiClient["request"];
    render(<App client={client(request)} initialEntries={["/chaves-api"]} />);
    expect(await screen.findByText("Automação")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Revogar" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("37d2e3ba-5920-4947-93ab-f9f905a78524");
    expect(screen.getByText("Automação")).toBeVisible();
  });

  it("indica chave revogada e não oferece nova revogação", async () => {
    const request = vi.fn(async () => ({
      data: [{ ...apiKey, revokedAt: "2030-01-02T12:00:00.000Z" }],
      pageInfo: { hasNextPage: false, nextCursor: null },
    })) as ApiClient["request"];
    render(<App client={client(request)} initialEntries={["/chaves-api"]} />);

    expect(await screen.findByText("Revogada")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Revogar" }),
    ).not.toBeInTheDocument();
  });
});
