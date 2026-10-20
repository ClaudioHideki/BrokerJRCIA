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
import { MetaConnectPage, loadFacebookSdk } from "./MetaConnect.js";
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
    path === "/v1/channels"
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
      path === "/v1/channels"
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

async function beginSignup() {
 let callback!: (response:{authResponse?:{code?:string}})=>void;
 window.FB={init:vi.fn(),login:vi.fn(cb=>{callback=cb;})};
 fixture.request.mockImplementation(async(path:string)=>path==='/v1/channels'
  ? {provider:'META',action:{type:'EMBEDDED_SIGNUP',state:'test-state',appId:'123',configId:'456',graphVersion:'v25.0',expiresAt:new Date(Date.now()+600000).toISOString()}}
  : {configured:true,connections:[]});
 render(<MemoryRouter><MetaConnectPage/></MemoryRouter>);
 fireEvent.click(await screen.findByRole('button',{name:'Preparar conexão oficial'}));
 fireEvent.click(await screen.findByRole('button',{name:'Continuar na Meta'}));
 return (response:{authResponse?:{code?:string}})=>callback(response);
}
function signupEvent(event:string,origin='https://www.facebook.com') {
 window.dispatchEvent(new MessageEvent('message',{origin,data:{type:'WA_EMBEDDED_SIGNUP',event,data:{waba_id:'54321',phone_number_id:'12345'}}}));
}
it.each(['CANCEL','ERROR'])('ends %s immediately and ignores a late SDK callback',async event=>{
 const callback=await beginSignup();
 await act(async()=>signupEvent(event));
 expect(await screen.findByRole('button',{name:'Preparar conexão oficial'})).toBeEnabled();
 await act(async()=>{signupEvent('FINISH');callback({authResponse:{code:'late-code'}});});
 expect(fixture.request.mock.calls.some(([path])=>path.endsWith('/complete'))).toBe(false);
});
it('requires both an allowed-origin finish and a code and completes only once',async()=>{
 const callback=await beginSignup();
 await act(async()=>{signupEvent('FINISH','https://invalid.example');callback({authResponse:{code:'test-code'}});});
 expect(fixture.request.mock.calls.some(([path])=>path.endsWith('/complete'))).toBe(false);
 await act(async()=>{signupEvent('FINISH');signupEvent('FINISH');callback({authResponse:{code:'test-code'}});});
 expect(fixture.request.mock.calls.filter(([path])=>path.endsWith('/complete'))).toHaveLength(1);
 expect(await screen.findByText(/Autorização recebida/)).toBeVisible();
});
it('requires a fresh state after a completion failure instead of replaying the consumed state',async()=>{
 const callback=await beginSignup();
 fixture.request.mockRejectedValueOnce(new Error('provider unavailable'));
 await act(async()=>{signupEvent('FINISH');callback({authResponse:{code:'test-code'}});});
 expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível concluir');
 expect(screen.getByRole('button',{name:'Preparar conexão oficial'})).toBeEnabled();
});
it('recovers when SDK login throws synchronously',async()=>{
 await beginSignup();
 // Cancel the current attempt, then create another prepared attempt.
 await act(async()=>signupEvent('CANCEL'));
 fireEvent.click(await screen.findByRole('button',{name:'Preparar conexão oficial'}));
 const button=await screen.findByRole('button',{name:'Continuar na Meta'});
 window.FB!.login=()=>{throw new Error('blocked');};
 fireEvent.click(button);
 expect(await screen.findByRole('button',{name:'Preparar conexão oficial'})).toBeEnabled();
 expect(screen.getByRole('alert')).toHaveTextContent(/abrir/);
});
it('allows SDK loading to retry if script loaded without FB',async()=>{
 const first=loadFacebookSdk();const rejected=expect(first).rejects.toThrow();
 document.querySelector<HTMLScriptElement>('script[src*="connect.facebook.net"]')!.dispatchEvent(new Event('load'));
 await rejected;
 const second=loadFacebookSdk();
 expect(second).not.toBe(first);
 window.FB={init:vi.fn(),login:vi.fn()};
 document.querySelector<HTMLScriptElement>('script[src*="connect.facebook.net"]')!.dispatchEvent(new Event('load'));
 await expect(second).resolves.toBe(window.FB);
 document.querySelector('script[src*="connect.facebook.net"]')?.remove();
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
