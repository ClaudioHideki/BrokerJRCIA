// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { MetaConnectPage } from "./MetaConnect.js";
const fixture = vi.hoisted(() => ({
  request: vi.fn(),
  role: "OWNER",
  id: "a",
}));
vi.mock("../auth/SessionProvider.js", () => ({
  useApiClient: () => fixture,
  useSession: () => ({
    tenantRevision: 1,
    session: { activeOrganization: { role: fixture.role, id: fixture.id } },
  }),
}));
afterEach(() => {
  cleanup();
  fixture.request.mockReset();
  fixture.role = "OWNER";
  fixture.id = "a";
  delete window.FB;
});
it("explains absent JRC configuration without requesting customer application secrets", async () => {
  fixture.request.mockResolvedValue({ configured: false, connections: [] });
  render(
    <MemoryRouter>
      <MetaConnectPage />
    </MemoryRouter>,
  );
  expect(
    await screen.findByText(/aguardando configuração do aplicativo JRC/),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Preparar conexão oficial" }),
  ).not.toBeInTheDocument();
});
it("explains the official connection journey while setup is pending", async () => {
  fixture.request.mockResolvedValue({ configured: false, connections: [] });
  render(
    <MemoryRouter>
      <MetaConnectPage />
    </MemoryRouter>,
  );
  await screen.findByText(/aguardando configuração do aplicativo JRC/);
  expect(
    screen.getByRole("heading", { name: "Como funciona a conexão oficial" }),
  ).toBeVisible();
  expect(screen.getByText("Autorizar a empresa")).toBeVisible();
  expect(screen.getByText("Selecionar o número")).toBeVisible();
  expect(screen.getByText("Concluir as verificações")).toBeVisible();
  expect(screen.getByText("Validar envio e recebimento")).toBeVisible();
  expect(
    screen.queryByRole("textbox", { name: /token|secret/i }),
  ).not.toBeInTheDocument();
});
it("purges connections and a deferred signup when switching between two owner organizations", async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  fixture.request.mockImplementation((path: string) =>
    path.endsWith("/start")
      ? pending
      : Promise.resolve({
          configured: true,
          connections:
            fixture.id === "a"
              ? [
                  {
                    id: "one",
                    phoneNumberId: "12345",
                    status: "READY",
                    pending: [],
                  },
                ]
              : [],
        }),
  );
  window.FB = { init: vi.fn(), login: vi.fn() };
  const view = render(
    <MemoryRouter>
      <MetaConnectPage />
    </MemoryRouter>,
  );
  expect(await screen.findByText("Número Meta 12345")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Preparar conexão oficial" }),
  );
  fixture.id = "b";
  view.rerender(
    <MemoryRouter>
      <MetaConnectPage />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(screen.queryByText("Número Meta 12345")).not.toBeInTheDocument(),
  );
  await act(async () =>
    finish({
      state: "a-state",
      appId: "123",
      configId: "456",
      graphVersion: "v25.0",
    }),
  );
  expect(
    screen.queryByRole("button", { name: "Continuar na Meta" }),
  ).not.toBeInTheDocument();
  expect(window.FB.init).not.toHaveBeenCalled();
});
it("ignores an old connection list arriving after the new tenant list", async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  fixture.request.mockImplementation(() =>
    fixture.id === "a"
      ? pending
      : Promise.resolve({ configured: true, connections: [] }),
  );
  const view = render(
    <MemoryRouter>
      <MetaConnectPage />
    </MemoryRouter>,
  );
  fixture.id = "b";
  view.rerender(
    <MemoryRouter>
      <MetaConnectPage />
    </MemoryRouter>,
  );
  await screen.findByText("Nenhuma conta oficial autorizada nesta empresa.");
  await act(async () =>
    finish({
      configured: true,
      connections: [
        { id: "old", phoneNumberId: "12345", status: "READY", pending: [] },
      ],
    }),
  );
  expect(screen.queryByText("Número Meta 12345")).not.toBeInTheDocument();
});
it("removes signup listeners and ignores old SDK callbacks after switching tenants", async () => {
  let callback!: (response: { authResponse?: { code?: string } }) => void;
  window.FB = {
    init: vi.fn(),
    login: vi.fn((cb) => {
      callback = cb;
    }),
  };
  fixture.request.mockImplementation((path: string) =>
    Promise.resolve(
      path.endsWith("/start")
        ? {
            state: "a-state",
            appId: "123",
            configId: "456",
            graphVersion: "v25.0",
          }
        : { configured: true, connections: [] },
    ),
  );
  const view = render(
    <MemoryRouter>
      <MetaConnectPage />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Preparar conexão oficial" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Continuar na Meta" }),
  );
  fixture.id = "b";
  view.rerender(
    <MemoryRouter>
      <MetaConnectPage />
    </MemoryRouter>,
  );
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://www.facebook.com",
        data: {
          type: "WA_EMBEDDED_SIGNUP",
          event: "FINISH",
          data: { waba_id: "54321", phone_number_id: "12345" },
        },
      }),
    );
    callback({ authResponse: { code: "old-code" } });
  });
  expect(
    fixture.request.mock.calls.some(([path]) => path.endsWith("/complete")),
  ).toBe(false);
  expect(
    screen.queryByText(
      "Autorização cancelada. Seus ativos permanecem na Meta.",
    ),
  ).not.toBeInTheDocument();
});
it("an operator cannot initialize signup", () => {
  fixture.role = "OPERATOR";
  render(
    <MemoryRouter>
      <MetaConnectPage />
    </MemoryRouter>,
  );
  expect(screen.getByText(/Somente o proprietário/)).toBeVisible();
  expect(fixture.request).not.toHaveBeenCalled();
});
it("shows pending setup and sends refresh to the selected authorized connection", async () => {
  fixture.request.mockResolvedValue({
    configured: true,
    connections: [
      {
        id: "one",
        channelId: "channel",
        phoneNumberId: "12345",
        wabaId: "54321",
        status: "PENDING",
        pending: ["META_PAYMENT_METHOD_REQUIRED"],
      },
    ],
  });
  render(
    <MemoryRouter>
      <MetaConnectPage />
    </MemoryRouter>,
  );
  expect(await screen.findByText("Configurar pagamento na Meta")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Verificar pendências" }));
  await waitFor(() =>
    expect(fixture.request).toHaveBeenCalledWith(
      "/v1/meta-onboarding/one/refresh",
      { method: "POST", body: "{}" },
    ),
  );
});
