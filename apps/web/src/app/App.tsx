import type { CSSProperties } from 'react';
import { BrowserRouter, MemoryRouter, Route, Routes } from 'react-router';

import { jrcCssVariables } from '@jrc/ui';

import { createApiClient, type ApiClient } from '../api/client.js';
import { ProtectedRoute, HomeRedirect } from '../auth/guards.js';
import { SessionProvider } from '../auth/SessionProvider.js';
import { AppShell } from '../layout/AppShell.js';
import { ApiKeysPage } from '../pages/ApiKeys.js';
import { IntegrationsPage } from '../pages/Integrations.js';
import { ConnectionDetailPage } from '../pages/ConnectionDetail.js';
import { ConnectionsPage } from '../pages/Connections.js';
import { LoginPage } from '../pages/Login.js';
import { NewConnectionPage } from '../pages/NewConnection.js';
import { OrganizationSelectPage } from '../pages/OrganizationSelect.js';
import { MessagingPage } from '../pages/Messaging.js';
import { PlatformPage } from '../pages/Platform.js';
import { MetaConnectPage } from '../pages/MetaConnect.js';
import { CompanyPage } from '../pages/Company.js';
import { DashboardPage } from '../pages/Dashboard.js';
import { ProvidersPage } from '../pages/Providers.js';
import { ProvisioningPage } from '../pages/Provisioning.js';
import { HealthPage, ReportsPage, BrainPage } from '../pages/Operations.js';
import { UsagePage } from '../pages/Usage.js';
import './console.css';
import './broker.css';
import './platform.css';

const browserClient = createApiClient();

function AppRoutes() {
  return (
    <Routes>
      <Route path="/jrc/*" element={<PlatformPage />} />
      <Route path="/" element={<HomeRedirect />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/selecionar-organizacao" element={<OrganizationSelectPage />} />
      <Route
        element={
          <ProtectedRoute>
            <AppShell />
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/providers" element={<ProvidersPage />} />
        <Route path="/provisionamento" element={<ProvisioningPage />} />
        <Route path="/health" element={<HealthPage />} />
        <Route path="/relatorios" element={<ReportsPage />} />
        <Route path="/uso-custos" element={<UsagePage />} />
        <Route path="/brain" element={<BrainPage />} />
        <Route path="/conexoes" element={<ConnectionsPage />} />
        <Route path="/conexoes/nova" element={<NewConnectionPage />} />
        <Route path="/conexoes/:id" element={<ConnectionDetailPage />} />
        <Route path="/chaves-api" element={<ApiKeysPage />} />
        <Route path="/integracoes" element={<IntegrationsPage />} />
        <Route path="/mensagens" element={<MessagingPage />} />
        <Route path="/whatsapp-oficial" element={<MetaConnectPage />} />
        <Route path="/minha-empresa" element={<CompanyPage />} />
      </Route>
      <Route path="*" element={<HomeRedirect />} />
    </Routes>
  );
}

export interface AppProps {
  client?: ApiClient;
  initialEntries?: string[];
}

export function App({ client = browserClient, initialEntries }: AppProps) {
  const content = (
    <SessionProvider client={client}>
      <AppRoutes />
    </SessionProvider>
  );
  const router = initialEntries ? (
    <MemoryRouter initialEntries={initialEntries}>{content}</MemoryRouter>
  ) : (
    <BrowserRouter>{content}</BrowserRouter>
  );
  return (
    <div className="jrc-app" style={jrcCssVariables as CSSProperties}>
      {router}
    </div>
  );
}
