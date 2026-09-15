// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { PlatformPage } from "./Platform.js";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("uses email and password without an authenticator when the server enables the local mode", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(async (url: string) =>
      url.endsWith("/auth/config")
        ? { ok: true, status: 200, json: async () => ({ mfaRequired: false }) }
        : { ok: false, status: 401 },
    );
  vi.stubGlobal("fetch", fetcher);
  render(
    <MemoryRouter>
      <PlatformPage />
    </MemoryRouter>,
  );
  await screen.findByLabelText("E-mail JRC");
  expect(
    screen.queryByLabelText("Código do autenticador"),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("E-mail JRC"), {
    target: { value: "admin@example.test" },
  });
  fireEvent.change(screen.getByLabelText("Senha"), {
    target: { value: "local-test-password" },
  });
  fireEvent.submit(
    screen
      .getByRole("button", { name: "Entrar na administração" })
      .closest("form")!,
  );
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/platform/auth/login",
      expect.objectContaining({
        body: JSON.stringify({
          email: "admin@example.test",
          password: "local-test-password",
        }),
      }),
    ),
  );
});
it("requires a separate platform login and authenticator code", async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 401 });
  vi.stubGlobal("fetch", fetcher);
  render(
    <MemoryRouter>
      <PlatformPage />
    </MemoryRouter>,
  );
  expect(await screen.findByLabelText("Código do autenticador")).toBeVisible();
  expect(
    screen.getByRole("heading", { name: "Administração JRC" }),
  ).toBeVisible();
  expect(screen.queryByText("Cadastrar empresa")).not.toBeInTheDocument();
});
it("explica o código temporário e orienta quando a chave de matrícula é digitada no campo", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
  render(
    <MemoryRouter>
      <PlatformPage />
    </MemoryRouter>,
  );
  const input = await screen.findByLabelText("Código do autenticador");
  expect(input).toHaveAccessibleDescription(
    /6 números gerados pelo aplicativo autenticador/,
  );
  fireEvent.change(input, { target: { value: "ABCDE" } });
  fireEvent.invalid(input);
  expect((input as HTMLInputElement).validationMessage).toBe(
    "Digite os 6 números gerados pelo aplicativo autenticador. A chave de configuração deve ser cadastrada no aplicativo.",
  );
  fireEvent.input(input, { target: { value: "123456" } });
  expect((input as HTMLInputElement).checkValidity()).toBe(true);
  expect(screen.getByText("Como configurar o primeiro acesso")).toBeVisible();
});
it("does not restore an old operator company list after logout and another login", async () => {
  const staff = {
    user: { id: "staff", email: "support@example.test", role: "SUPPORT" },
    csrfToken: "nonce",
    expiresAt: "2026-09-14",
  };
  let finish!: (value: unknown) => void;
  const oldList = new Promise((resolve) => {
    finish = resolve;
  });
  let lists = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith("/organizations")
          ? ++lists === 1
            ? oldList
            : { organizations: [] }
          : url.endsWith("/auth/logout")
            ? { ok: true }
            : staff,
    })),
  );
  render(
    <MemoryRouter>
      <PlatformPage />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Sair da administração" }),
  );
  await screen.findByLabelText("Código do autenticador");
  fireEvent.change(screen.getByLabelText("E-mail JRC"), {
    target: { value: "other@example.test" },
  });
  fireEvent.change(screen.getByLabelText("Senha"), {
    target: { value: "long-test-password" },
  });
  fireEvent.change(screen.getByLabelText("Código do autenticador"), {
    target: { value: "123456" },
  });
  fireEvent.submit(
    screen
      .getByRole("button", { name: "Entrar na administração" })
      .closest("form")!,
  );
  await screen.findByRole("button", { name: "Sair da administração" });
  await act(async () =>
    finish({
      organizations: [
        {
          id: "old",
          name: "Old company",
          slug: "old",
          status: "ACTIVE",
          plan: "old",
        },
      ],
    }),
  );
  expect(screen.queryByText("Old company")).not.toBeInTheDocument();
});
it("support can inspect companies but cannot edit or create them", async () => {
  const fetcher = vi.fn().mockImplementation(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () =>
      url.endsWith("/auth/session")
        ? {
            user: {
              id: "staff",
              email: "support@example.test",
              role: "SUPPORT",
            },
            csrfToken: "nonce",
            expiresAt: "2026-09-14",
          }
        : {
            organizations: [
              {
                id: "company-a",
                name: "Empresa A",
                slug: "a",
                status: "ACTIVE",
                plan: "Inicial",
              },
            ],
          },
  }));
  vi.stubGlobal("fetch", fetcher);
  render(
    <MemoryRouter>
      <PlatformPage />
    </MemoryRouter>,
  );
  expect(await screen.findByText("Empresa A")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Cadastrar empresa" }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Motivo do atendimento"), {
    target: { value: "Chamado de suporte 123" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Atualizar empresas" }));
  await waitFor(() =>
    expect(fetcher).toHaveBeenLastCalledWith(
      "/v1/platform/organizations",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-platform-reason": "Chamado de suporte 123",
        }),
      }),
    ),
  );
});

const organization = {
  id: "company-a",
  name: "Empresa A",
  slug: "empresa-a",
  status: "ACTIVE",
  plan: "Teste",
  limits: {
    maxInstances: 2,
    maxUsers: 3,
    messagesPerDay: 100,
    maxPendingMessages: 50,
  },
};
function platformFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn().mockImplementation(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () =>
      overrides[url] ??
      (url.endsWith("/auth/config")
        ? { mfaRequired: false }
        : url.endsWith("/auth/session")
          ? {
              user: {
                id: "staff",
                email: "admin@example.test",
                role: "SUPER_ADMIN",
              },
              csrfToken: "nonce",
              expiresAt: "2026-09-15",
            }
          : url.endsWith("/organizations")
            ? {
                organizations: [
                  organization,
                  {
                    ...organization,
                    id: "company-b",
                    name: "Empresa B",
                    slug: "empresa-b",
                    status: "SUSPENDED",
                  },
                ],
              }
            : url.endsWith("/memberships")
              ? {
                  memberships: [
                    {
                      userId: "owner-a",
                      email: "owner@example.test",
                      role: "OWNER",
                      status: "ACTIVE",
                    },
                  ],
                }
              : url.endsWith("/monitor")
                ? { connections: 1, queue: 0, failures: 2, webhooks: 5 }
                : { ok: true }),
  }));
}

it("opens the executive admin shell with real company totals and dedicated navigation", async () => {
  vi.stubGlobal("fetch", platformFetch());
  render(
    <MemoryRouter initialEntries={["/jrc"]}>
      <PlatformPage />
    </MemoryRouter>,
  );
  await screen.findByText("Empresa A");
  expect(
    screen.getByRole("heading", { level: 1, name: "Visão geral" }),
  ).toBeVisible();
  const navigation = screen.getByRole("navigation", {
    name: "Administração JRC",
  });
  expect(
    within(navigation).getByRole("link", { name: "Empresas" }),
  ).toHaveAttribute("href", "/jrc/empresas");
  expect(
    within(navigation).queryByRole("link", { name: "Conexões" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText("Empresas cadastradas").closest("article"),
  ).toHaveTextContent("2");
  expect(
    screen.getByRole("img", {
      name: "Situação das empresas: 1 ativa, 1 suspensa, 0 desativada",
    }),
  ).toBeVisible();
  fireEvent.click(within(navigation).getByRole("link", { name: "Empresas" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Buscar empresa" }), {
    target: { value: "empresa-b" },
  });
  expect(
    screen.queryByRole("button", { name: "Abrir Empresa A" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Abrir Empresa B" })).toBeVisible();
});

it("loads company management and saves the existing limits through the admin API", async () => {
  const fetcher = platformFetch();
  vi.stubGlobal("fetch", fetcher);
  render(
    <MemoryRouter initialEntries={["/jrc/empresas"]}>
      <PlatformPage />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Abrir Empresa A" }),
  );
  await screen.findByText("owner@example.test");
  fireEvent.click(screen.getByRole("tab", { name: "Plano e limites" }));
  expect(screen.getByLabelText("Conexões")).toHaveValue(2);
  fireEvent.change(screen.getByLabelText("Conexões"), {
    target: { value: "4" },
  });
  fireEvent.submit(
    screen
      .getByRole("button", { name: "Salvar situação e plano" })
      .closest("form")!,
  );
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/platform/organizations/company-a",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({ "x-csrf-token": "nonce" }),
        body: JSON.stringify({
          status: "ACTIVE",
          plan: "Teste",
          limits: { ...organization.limits, maxInstances: 4 },
        }),
      }),
    ),
  );
  expect(
    fetcher.mock.calls.every(([url]) =>
      String(url).startsWith("/v1/platform/"),
    ),
  ).toBe(true);
});

it("shows an unavailable state instead of zero companies when loading fails", async () => {
  const fetcher = platformFetch();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      url.endsWith("/organizations")
        ? Promise.resolve({ ok: false, status: 500 })
        : fetcher(url),
    ),
  );
  render(
    <MemoryRouter initialEntries={["/jrc"]}>
      <PlatformPage />
    </MemoryRouter>,
  );
  await screen.findByRole("alert");
  expect(
    screen.queryByText("Nenhuma empresa cadastrada."),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Empresas cadastradas")).not.toBeInTheDocument();
  expect(
    screen.getByText(
      "Os indicadores estarão disponíveis após carregar as empresas.",
    ),
  ).toBeVisible();
});

it("does not mix company users when a previous inspection finishes late", async () => {
  let finish!: (value: unknown) => void;
  const delayed = new Promise((resolve) => {
    finish = resolve;
  });
  const fetcher = platformFetch({
    "/v1/platform/organizations/company-b/memberships": {
      memberships: [
        {
          userId: "owner-b",
          email: "owner-b@example.test",
          role: "OWNER",
          status: "ACTIVE",
        },
      ],
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      url === "/v1/platform/organizations/company-a/memberships"
        ? Promise.resolve({ ok: true, status: 200, json: () => delayed })
        : fetcher(url),
    ),
  );
  render(
    <MemoryRouter initialEntries={["/jrc/empresas"]}>
      <PlatformPage />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Abrir Empresa A" }),
  );
  fireEvent.change(
    screen.getByRole("combobox", { name: "Empresa em atendimento" }),
    { target: { value: "company-b" } },
  );
  await screen.findByText("owner-b@example.test");
  await act(async () =>
    finish({
      memberships: [
        {
          userId: "old-owner",
          email: "old-owner@example.test",
          role: "OWNER",
          status: "ACTIVE",
        },
      ],
    }),
  );
  expect(screen.queryByText("old-owner@example.test")).not.toBeInTheDocument();
  expect(screen.getByText("owner-b@example.test")).toBeVisible();
});

it("preserves support permissions in every company tab", async () => {
  vi.stubGlobal(
    "fetch",
    platformFetch({
      "/v1/platform/auth/session": {
        user: { id: "support", email: "support@example.test", role: "SUPPORT" },
        csrfToken: "nonce",
        expiresAt: "2026-09-15",
      },
    }),
  );
  render(
    <MemoryRouter initialEntries={["/jrc/usuarios"]}>
      <PlatformPage />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Abrir Empresa A" }),
  );
  await screen.findByText("owner@example.test");
  expect(
    screen.queryByRole("button", { name: "Salvar acesso" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Plano e limites" }));
  expect(
    screen.queryByRole("button", { name: "Salvar situação e plano" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Suporte" }));
  expect(
    screen.getByRole("button", { name: "Registrar atendimento de suporte" }),
  ).toBeEnabled();
});

it("creates a company with its owner and limits using the audited admin endpoint", async () => {
  const fetcher = platformFetch();
  vi.stubGlobal("fetch", fetcher);
  render(
    <MemoryRouter initialEntries={["/jrc"]}>
      <PlatformPage />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Cadastrar empresa" }),
  );
  fireEvent.change(screen.getByLabelText("Nome da empresa"), {
    target: { value: "Nova Empresa" },
  });
  fireEvent.change(screen.getByLabelText("Identificador"), {
    target: { value: "nova-empresa" },
  });
  fireEvent.change(screen.getByLabelText("E-mail do responsável"), {
    target: { value: "new-owner@example.test" },
  });
  fireEvent.change(screen.getByLabelText("Senha inicial do responsável"), {
    target: { value: "synthetic-test-password" },
  });
  fireEvent.submit(
    screen.getByRole("button", { name: "Salvar empresa" }).closest("form")!,
  );
  await screen.findByText("Empresa cadastrada com responsável e limites.");
  expect(fetcher).toHaveBeenCalledWith(
    "/v1/platform/organizations",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        "x-platform-reason": "Consulta operacional da plataforma",
        "x-csrf-token": "nonce",
      }),
      body: JSON.stringify({
        name: "Nova Empresa",
        slug: "nova-empresa",
        ownerEmail: "new-owner@example.test",
        ownerPassword: "synthetic-test-password",
        plan: "Inicial",
        limits: {
          maxInstances: 5,
          maxUsers: 10,
          messagesPerDay: 1000,
          maxPendingMessages: 1000,
        },
      }),
    }),
  );
});

it("saves a membership for the selected company and clears the password field", async () => {
  const fetcher = platformFetch();
  vi.stubGlobal("fetch", fetcher);
  render(
    <MemoryRouter initialEntries={["/jrc/usuarios"]}>
      <PlatformPage />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Abrir Empresa B" }),
  );
  await screen.findByText("owner@example.test");
  fireEvent.change(screen.getByLabelText("E-mail do usuário"), {
    target: { value: "new-user@example.test" },
  });
  fireEvent.change(
    screen.getByLabelText("Senha inicial (somente novo usuário)"),
    { target: { value: "synthetic-test-password" } },
  );
  fireEvent.submit(
    screen.getByRole("button", { name: "Salvar acesso" }).closest("form")!,
  );
  await screen.findByText("Acesso do usuário atualizado.");
  expect(fetcher).toHaveBeenCalledWith(
    "/v1/platform/organizations/company-b/memberships",
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({
        email: "new-user@example.test",
        password: "synthetic-test-password",
        role: "VIEWER",
        status: "ACTIVE",
      }),
    }),
  );
  expect(
    screen.getByLabelText("Senha inicial (somente novo usuário)"),
  ).toHaveValue("");
});

it("opens the mobile navigation with keyboard focus and restores it on Escape", async () => {
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("fetch", platformFetch());
  render(
    <MemoryRouter initialEntries={["/jrc"]}>
      <PlatformPage />
    </MemoryRouter>,
  );
  await screen.findByText("Empresa A");
  expect(
    screen.queryByRole("navigation", { name: "Administração JRC" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Abrir navegação" }));
  expect(screen.getByRole("link", { name: "Dashboard" })).toHaveFocus();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.getByRole("button", { name: "Abrir navegação" })).toHaveFocus();
  expect(
    screen.queryByRole("navigation", { name: "Administração JRC" }),
  ).not.toBeInTheDocument();
});
