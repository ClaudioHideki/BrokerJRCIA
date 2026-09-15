// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ChatwootPanel } from "./ChatwootPanel.js";
import { StrictMode } from "react";
const id = "81555d45-b1a2-4a3f-ab95-c1459b0df0d0";
const status = {
  configured: true,
  baseUrl: "https://conversas.test",
  provisioningAvailable: false,
  account: null,
  connections: [],
  jobs: {},
};
afterEach(cleanup);
it("loads inbox agents after the StrictMode mount cycle", async () => {
  const request = vi.fn(async (path: string) => path === "" ? {
    ...status,
    account: { accountId: 1, status: "READY", hasCredential: true, lastError: null },
    connections: [{ id, channelId: id, name: "Comercial", inboxId: 31, status: "READY", webhookUrl: "https://broker.test/events", lastError: null }],
  } : path.endsWith("/agents") ? { data: [{ id: 5, name: "Atendente", email: "atendente@example.test", assigned: false }] } : { data: [] });
  render(<StrictMode><ChatwootPanel request={request} canManage platform={false} /></StrictMode>);
  fireEvent.click(await screen.findByText("Atendentes desta caixa"));
  fireEvent.click(screen.getByRole("button", { name: "Consultar atendentes" }));
  expect(await screen.findByLabelText(/Atendente · atendente/)).toBeVisible();
});
it("explains missing server configuration without displaying a false ready state", async () => {
  render(
    <ChatwootPanel
      request={vi.fn().mockResolvedValue({ ...status, configured: false })}
      canManage
      platform={false}
    />,
  );
  expect(
    await screen.findByText(/aguardando configuração no servidor/),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Vincular conta" }),
  ).not.toBeInTheDocument();
});
it("binds the chosen account and clears the submitted credential", async () => {
  const request = vi.fn(async (path: string) =>
    path === "/account"
      ? {
          ...status,
          account: {
            accountId: 1,
            status: "READY",
            hasCredential: true,
            lastError: null,
          },
        }
      : path === ""
        ? status
        : { data: [] },
  );
  render(<ChatwootPanel request={request} canManage platform={false} />);
  fireEvent.change(await screen.findByLabelText("ID da conta"), {
    target: { value: "1" },
  });
  fireEvent.change(screen.getByLabelText(/^Token de acesso do JRC Conversas/), {
    target: { value: "tenant-private-token" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Vincular conta" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("/account", "PUT", {
      accountId: 1,
      token: "tenant-private-token",
    }),
  );
  expect(
    screen.getByLabelText(/^Token de acesso do JRC Conversas/),
  ).toHaveValue("");
});
it("offers only the selected company connections and creates an API inbox", async () => {
  const ready = {
    ...status,
    account: {
      accountId: 1,
      status: "READY",
      hasCredential: true,
      lastError: null,
    },
  };
  const request = vi.fn(async (path: string) =>
    path === ""
      ? ready
      : path === "/sources"
        ? {
            data: [
              { kind: "instance", id, name: "Comercial", label: "QR Code" },
            ],
          }
        : { data: [] },
  );
  render(<ChatwootPanel request={request} canManage platform={false} />);
  fireEvent.change(await screen.findByLabelText("Conexão WhatsApp"), {
    target: { value: id },
  });
  fireEvent.change(screen.getByLabelText("Nome da caixa"), {
    target: { value: "Atendimento JRC" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Conectar caixa" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("/connections", "POST", {
      instanceId: id,
      name: "Atendimento JRC",
    }),
  );
});
it("keeps viewers read-only and never loads administrative choices", async () => {
  const request = vi.fn(async (path: string) =>
    path === "" ? status : { data: [] },
  );
  render(
    <ChatwootPanel request={request} canManage={false} platform={false} />,
  );
  expect(await screen.findByText(/administrador da empresa/)).toBeVisible();
  expect(request).not.toHaveBeenCalledWith("/sources");
  expect(
    screen.queryByRole("button", { name: "Vincular conta" }),
  ).not.toBeInTheDocument();
});
it("offers reconciliation instead of a blind retry for an uncertain delivery", async () => {
  const job = {
    id,
    integrationId: id,
    messageId: id,
    kind: "MIRROR_MESSAGE",
    status: "UNKNOWN",
    attempts: 1,
    lastError: "CHATWOOT_OUTCOME_UNKNOWN",
    operation: "SEND_MESSAGE",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const request = vi.fn(async (path: string) =>
    path === "" ? status : path === "/jobs" ? { data: [job] } : { data: [] },
  );
  render(<ChatwootPanel request={request} canManage platform={false} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Conferir entrega" }),
  );
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("/jobs/" + id + "/reconcile", "POST", {
      reason: "Correção verificada pelo administrador",
    }),
  );
  expect(
    screen.queryByRole("button", { name: "Reprocessar" }),
  ).not.toBeInTheDocument();
});
