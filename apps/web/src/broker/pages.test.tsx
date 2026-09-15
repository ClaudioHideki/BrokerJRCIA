// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { App } from "../app/App.js";
import { createDemoClient, demoOverview } from "./demo.js";
import type { ApiClient } from "../api/client.js";
it("mostra indicadores do servidor e refaz a consulta ao trocar o período", async () => {
  const client = createDemoClient();
  const request = vi.spyOn(client, "request");
  render(<App client={client} initialEntries={["/dashboard"]} />);
  expect(
    await screen.findByRole("heading", { name: "Volume de mensagens" }, { timeout: 5000 }),
  ).toBeVisible();
  expect(screen.getAllByText("842")).toHaveLength(2);
  fireEvent.change(screen.getByLabelText("Período dos indicadores"), {
    target: { value: "7" },
  });
  await waitFor(() =>
    expect(request).toHaveBeenLastCalledWith(
      "/v1/organization/overview?days=7",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ),
  );
});
it("uma falha de indicadores não vira zeros ou gráfico fictício", async () => {
  const client = createDemoClient();
  client.request = vi.fn().mockRejectedValue(new Error("offline"));
  render(<App client={client} initialEntries={["/dashboard"]} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Não foi possível atualizar",
  );
  expect(
    screen.queryByRole("heading", { name: "Volume de mensagens" }),
  ).not.toBeInTheDocument();
});
it("limpa indicadores na troca de empresa e ignora resposta antiga atrasada", async () => {
  const client = createDemoClient();
  const session = await client.restore();
  const second = {
    ...session.activeOrganization,
    id: "22222222-2222-4222-8222-222222222222",
    name: "Segunda empresa",
  };
  client.restore = async () => ({
    ...session,
    organizations: [session.activeOrganization, second],
  });
  const purges = new Set<() => void>();
  client.registerTenantPurge = (fn) => {
    purges.add(fn);
    return () => {
      purges.delete(fn);
    };
  };
  client.switchOrganization = async () => {
    purges.forEach((fn) => fn());
    return {
      ...session,
      activeOrganization: second,
      organizations: [session.activeOrganization, second],
    };
  };
  let resolveOld: ((data: unknown) => void) | undefined;
  let calls = 0;
  client.request = vi.fn(async () => {
    calls++;
    if (calls === 1)
      return new Promise((resolve) => {
        resolveOld = resolve;
      });
    const d = demoOverview();
    d.connections = {
      total: 1,
      online: 1,
      attention: 0,
      disconnected: 0,
      provisioning: 0,
      unobserved: 0,
    };
    return d;
  }) as ApiClient["request"];
  render(<App client={client} initialEntries={["/dashboard"]} />);
  await screen.findByRole("heading", { name: "Visão geral" });
  fireEvent.change(screen.getByLabelText("Organização ativa"), {
    target: { value: second.id },
  });
  await screen.findByRole("heading", { name: "Volume de mensagens" });
  resolveOld?.(demoOverview());
  await waitFor(() =>
    expect(screen.queryByText("842")).not.toBeInTheDocument(),
  );
});
it("apresenta os dois canais JRC sem expor os motores técnicos ao cliente", async () => {
  render(<App client={createDemoClient()} initialEntries={["/providers"]} />);
  await screen.findByRole("heading", { name: "Canais JRC" });
  expect(
    screen.getByRole("heading", { name: "WhatsApp Business por QR Code" }),
  ).toBeVisible();
  expect(
    screen.getByRole("heading", { name: "WhatsApp Oficial" }),
  ).toBeVisible();
  expect(
    screen.getByRole("link", { name: /Conectar por QR Code/ }),
  ).toHaveAttribute("href", "/conexoes/nova");
  expect(
    screen.getByRole("link", { name: /Conectar WhatsApp Oficial/ }),
  ).toHaveAttribute("href", "/whatsapp-oficial");
  expect(document.body).not.toHaveTextContent(
    /Evolution|Baileys|WAHA|Twilio|Ligo/i,
  );
});
it("JRC Brain distingue diagnóstico por regras de uma IA generativa", async () => {
  render(<App client={createDemoClient()} initialEntries={["/brain"]} />);
  await screen.findByRole("heading", { name: "O que precisa da sua atenção?" });
  fireEvent.click(
    screen.getByRole("button", { name: "Resultados dos envios" }),
  );
  expect(
    screen.getByRole("heading", { name: "Como estão os envios?" }),
  ).toBeVisible();
  expect(screen.getByText(/sem modelo de IA/)).toBeVisible();
});
it("VIEWER não acessa o assistente de criação em massa", async () => {
  const client = createDemoClient();
  const session = await client.restore();
  client.restore = async () => ({
    ...session,
    activeOrganization: { ...session.activeOrganization, role: "VIEWER" },
  });
  render(<App client={client} initialEntries={["/provisionamento"]} />);
  expect(
    await screen.findByText("Seu acesso é somente leitura."),
  ).toBeVisible();
  expect(screen.queryByLabelText("Arquivo CSV")).not.toBeInTheDocument();
});
it("cria somente após revisão explícita e para em resultado incerto", async () => {
  const client = createDemoClient();
  const original = client.request;
  const create = vi.fn(async () => ({
    instance: {
      id: "33333333-3333-4333-8333-000000000010",
      organizationId: "11111111-1111-4111-8111-111111111111",
      providerAccountId: "22222222-2222-4222-8222-222222222222",
      name: "A",
      provider: "BAILEYS",
      status: "PROVISIONING",
      createdAt: "2026-09-15T12:00:00Z",
      updatedAt: "2026-09-15T12:00:00Z",
    },
    operationId: null,
    replayed: false,
    pending: true,
    reconciliationRequired: true,
  }));
  client.request = (async (path: string, init?: RequestInit) =>
    init?.method === "POST"
      ? create()
      : original(path, init)) as ApiClient["request"];
  render(<App client={client} initialEntries={["/provisionamento"]} />);
  const input = await screen.findByLabelText("Arquivo CSV");
  const file = new File(["nome\nA\nB"], "canais.csv", { type: "text/csv" });
  Object.defineProperty(file, "text", { value: async () => "nome\nA\nB" });
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByText("2 nomes válidos encontrados.");
  fireEvent.click(screen.getByRole("button", { name: "Revisar nomes" }));
  fireEvent.click(screen.getByRole("button", { name: "Configurar" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Revisar cadastro" }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Revisar cadastro" }));
  expect(create).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Criar 2 conexões" }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Conferi os nomes e a empresa de destino.",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Criar 2 conexões" }));
  expect(
    await screen.findByRole("heading", { name: "Resultado do lote" }),
  ).toBeVisible();
  expect(create).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Conferência necessária")).toBeVisible();
  expect(screen.getByText("Não iniciada")).toBeVisible();
});
