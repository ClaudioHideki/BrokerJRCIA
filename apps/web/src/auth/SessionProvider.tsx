import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  CONSOLE_ORGANIZATION_SWITCH_REJECTED_CODE,
  type LoginRequest,
  type OrganizationSummary,
} from '@jrc/contracts';

import { ApiClientError, type ApiClient, type BrowserSession } from '../api/client.js';
import type {
  SessionContextValue,
  SessionNotice,
  SessionStatus,
} from './session-machine.js';

const SessionContext = createContext<SessionContextValue | null>(null);
const ApiClientContext = createContext<ApiClient | null>(null);

export interface SessionProviderProps {
  client: ApiClient;
  children: ReactNode;
}

function browserSession(value: BrowserSession): BrowserSession {
  return {
    user: value.user,
    activeOrganization: value.activeOrganization,
    organizations: value.organizations,
  };
}

function noticeFor(error: unknown, fallback: string): SessionNotice {
  return error instanceof ApiClientError
    ? { message: error.message, ...(error.requestId ? { requestId: error.requestId } : {}) }
    : { message: fallback };
}

export function SessionProvider({ client, children }: SessionProviderProps) {
  const [status, setStatus] = useState<SessionStatus>('booting');
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [tenantRevision, setTenantRevision] = useState(0);
  const [selectionOrganizations, setSelectionOrganizations] = useState<OrganizationSummary[]>([]);
  const [selectionPending, setSelectionPending] = useState(false);
  const [switchPending, setSwitchPending] = useState(false);
  const [notice, setNotice] = useState<SessionNotice | null>(null);
  const selectionToken = useRef<string | null>(null);
  const selectionInFlight = useRef(false);
  const switchInFlight = useRef(false);
  const restoreStarted = useRef(false);
  const requestGeneration = useRef(0);

  const invalidatePending = useCallback(() => {
    requestGeneration.current += 1;
    selectionToken.current = null;
    selectionInFlight.current = false;
    switchInFlight.current = false;
    setSelectionPending(false);
    setSwitchPending(false);
  }, []);

  useEffect(() => client.subscribeToSessionExpiration(() => {
    invalidatePending();
    setSession(null);
    setSelectionOrganizations([]);
    setNotice({ message: 'Sua sessão expirou. Entre novamente.' });
    setStatus('expired');
  }), [client, invalidatePending]);

  useEffect(() => {
    if (restoreStarted.current) return;
    restoreStarted.current = true;
    const generation = requestGeneration.current;
    void client.restore().then((restored) => {
      if (generation !== requestGeneration.current) return;
      setSession(browserSession(restored));
      setNotice(null);
      setStatus('authenticated');
    }).catch((error: unknown) => {
      if (generation !== requestGeneration.current) return;
      setSession(null);
      setStatus('anonymous');
      if (!(error instanceof ApiClientError && error.status === 401)) {
        setNotice(noticeFor(error, 'Não foi possível restaurar sua sessão.'));
      }
    });
  }, [client]);

  const login = useCallback(async (input: LoginRequest) => {
    const generation = ++requestGeneration.current;
    selectionToken.current = null;
    selectionInFlight.current = false;
    setSelectionPending(false);
    setNotice(null);
    try {
      const result = await client.login(input);
      if (generation !== requestGeneration.current) return;
      selectionToken.current = result.selectionToken;
      setSelectionOrganizations(result.organizations);
      setSession(null);
      setStatus('selecting');
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      setStatus('anonymous');
      setNotice(noticeFor(error, 'Não foi possível entrar. Tente novamente.'));
    }
  }, [client]);

  const selectOrganization = useCallback(async (organizationId: string) => {
    if (selectionInFlight.current) return;
    const token = selectionToken.current;
    if (!token) {
      setNotice({ message: 'A seleção expirou. Entre novamente.' });
      setStatus('anonymous');
      return;
    }
    selectionToken.current = null;
    selectionInFlight.current = true;
    setSelectionPending(true);
    const generation = ++requestGeneration.current;
    setNotice(null);
    try {
      const selected = await client.selectOrganization({ selectionToken: token, organizationId });
      if (generation !== requestGeneration.current) return;
      setSelectionOrganizations([]);
      setSession(browserSession(selected));
      setStatus('authenticated');
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      setSelectionOrganizations([]);
      setStatus('anonymous');
      setNotice(noticeFor(error, 'Não foi possível selecionar a organização.'));
    } finally {
      selectionInFlight.current = false;
      setSelectionPending(false);
    }
  }, [client]);

  const switchOrganization = useCallback(async (organizationId: string) => {
    if (switchInFlight.current) return;
    switchInFlight.current = true;
    setSwitchPending(true);
    const generation = ++requestGeneration.current;
    setNotice(null);
    try {
      const switched = await client.switchOrganization({ organizationId });
      if (generation !== requestGeneration.current) return;
      setSession(browserSession(switched));
      setStatus('authenticated');
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      if (
        error instanceof ApiClientError
        && error.status === 409
        && error.code === CONSOLE_ORGANIZATION_SWITCH_REJECTED_CODE
      ) {
        setTenantRevision((current) => current + 1);
      }
      setNotice(noticeFor(error, 'Não foi possível trocar de organização.'));
    } finally {
      switchInFlight.current = false;
      setSwitchPending(false);
    }
  }, [client]);

  const logout = useCallback(async () => {
    invalidatePending();
    setNotice(null);
    setSession(null);
    setSelectionOrganizations([]);
    setStatus('anonymous');
    try {
      await client.logout();
    } catch (error) {
      if (!(error instanceof ApiClientError && error.status === 401)) {
        setNotice(noticeFor(error, 'A sessão local foi encerrada.'));
      }
    } finally {
      setStatus('anonymous');
    }
  }, [client, invalidatePending]);

  const value = useMemo<SessionContextValue>(() => ({
    status,
    session,
    tenantRevision,
    selectionOrganizations,
    selectionPending,
    switchPending,
    notice,
    login,
    selectOrganization,
    switchOrganization,
    logout,
  }), [
    status,
    session,
    tenantRevision,
    selectionOrganizations,
    selectionPending,
    switchPending,
    notice,
    login,
    selectOrganization,
    switchOrganization,
    logout,
  ]);

  return (
    <ApiClientContext.Provider value={client}>
      <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
    </ApiClientContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession deve ser usado dentro de SessionProvider.');
  return value;
}

export function useApiClient(): ApiClient {
  const value = useContext(ApiClientContext);
  if (!value) throw new Error('useApiClient deve ser usado dentro de SessionProvider.');
  return value;
}
