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
it('distinguishes historical work from live messages and counts its pending lane',async()=>{
 const request=vi.fn(async(path:string)=>path===''?{...status,jobs:{HISTORY_PENDING:2}}:path==='/jobs'?{data:[{
  id,integrationId:id,messageId:id,kind:'MIRROR_MESSAGE',historical:true,status:'HISTORY_PENDING',attempts:0,lastError:null,operation:null,
  createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
 }]}:{data:[]});
 render(<ChatwootPanel request={request} canManage platform={false}/>);
 expect(await screen.findByText('Histórico → JRC Conversas')).toBeVisible();
 expect(screen.getByText('Histórico aguardando importação')).toBeVisible();
 expect(screen.getByText('2')).toBeVisible();
});
it('describes configured bindings without advertising unverified delivery as ready', async () => {
  const request = vi.fn(async (path: string) => path === '' ? { ...status,
    account: { accountId: 1, status: 'READY', lastError: null, hasCredential: true },
    connections: [{ id, channelId: id, name: 'Comercial', inboxId: 31, status: 'READY', webhookUrl: 'https://broker.test/events', lastError: null }],
  } : { data: [] });
  render(<ChatwootPanel request={request} canManage platform={false} />);
  expect(await screen.findByText('Vínculos configurados')).toBeVisible();
  expect(screen.queryByText('Caixas prontas')).not.toBeInTheDocument();
  expect(screen.getByText(/A configuração da caixa não confirma/)).toBeVisible();
  expect(screen.getByRole('list', { name: 'Etapas para integrar a central' })).toBeVisible();
});
it('keeps new control/embed surfaces hidden when flags are off without hiding the integration', async () => {
  const request = vi.fn(async (path: string) => path === '' ? { ...status, controlEnabled: false, embedEnabled: false,
    account: { accountId: 1, status: 'READY', lastError: null, hasCredential: true } } : { data: [] });
  render(<ChatwootPanel request={request} canManage platform={false} />);
  expect(await screen.findByText(/Conta 1 vinculada/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Preparar painel do Chatwoot' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Abrir controle de conexões' })).not.toBeInTheDocument();
});
it('requests an external destination without collecting a token before approval', async () => {
  const request = vi.fn(async (path: string) => path === '' ? { ...status, managedBaseUrl: 'https://conversas.test', externalDestinationsEnabled: true,
    destination: { organizationId: id, baseUrl: 'https://customer.example.com', mode: 'EXTERNAL', approvalStatus: 'PENDING', revision: 2, mediaOrigins: [] } } : { data: [] });
  render(<ChatwootPanel request={request} canManage platform={false} />);
  expect(await screen.findByText(/Aguardando aprovação da equipe JRC/)).toBeVisible();
  expect(screen.queryByLabelText(/^Token de acesso/)).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Instalação de atendimento'), { target: { value: 'EXTERNAL' } });
  fireEvent.change(screen.getByLabelText('Endereço do Chatwoot'), { target: { value: 'https://next.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Solicitar destino' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('/destination', 'PUT', { mode: 'EXTERNAL', baseUrl: 'https://next.example.com' }));
});
it('lets the platform review an exact destination revision and media origins', async () => {
  const request = vi.fn(async (path: string) => path === '' ? { ...status, externalDestinationsEnabled: true,
    destination: { organizationId: id, baseUrl: 'https://customer.example.com', mode: 'EXTERNAL', approvalStatus: 'PENDING', revision: 2, mediaOrigins: [] } } : { data: [] });
  render(<ChatwootPanel request={request} canManage platform />);
  fireEvent.change(await screen.findByLabelText('Domínios de anexos autorizados'), { target: { value: 'https://cdn.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Aprovar destino revisado' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('/destination/approve', 'POST', { revision: 2, mediaOrigins: ['https://cdn.example.com'] }));
});
it('lets platform administrators update attachment origins on an approved destination without changing its address', async () => {
  const request = vi.fn(async (path: string) => path === '' ? { ...status, externalDestinationsEnabled: true,
    destination: { organizationId: id, baseUrl: 'https://customer.example.com', mode: 'EXTERNAL', approvalStatus: 'APPROVED', revision: 3,
      mediaOrigins: ['https://existing.example.com'] } } : { data: [] });
  render(<ChatwootPanel request={request} canManage platform />);
  const origins = await screen.findByLabelText('Domínios de anexos autorizados');
  expect(origins).toHaveValue('https://existing.example.com');
  fireEvent.change(origins, { target: { value: 'https://existing.example.com\nhttps://cdn.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar domínios de anexos' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('/destination/approve', 'POST', {
    revision: 3, mediaOrigins: ['https://existing.example.com', 'https://cdn.example.com'],
  }));
  expect(request).not.toHaveBeenCalledWith('/destination', expect.anything(), expect.anything());
});
it.each([{ platform: false, canManage: true }, { platform: true, canManage: false }])(
  'does not expose attachment approval outside platform management: %j', async permissions => {
    const request = vi.fn(async (path: string) => path === '' ? { ...status, externalDestinationsEnabled: true,
      destination: { organizationId: id, baseUrl: 'https://customer.example.com', mode: 'EXTERNAL', approvalStatus: 'APPROVED', revision: 3,
        mediaOrigins: ['https://existing.example.com'] } } : { data: [] });
    render(<ChatwootPanel request={request} {...permissions} />);
    expect(await screen.findByText('Destino autorizado. A compatibilidade e a entrega ainda precisam ser verificadas.')).toBeVisible();
    expect(screen.queryByLabelText('Domínios de anexos autorizados')).not.toBeInTheDocument();
  }
);
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
