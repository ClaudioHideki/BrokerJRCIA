import type { CSSProperties } from 'react';
import { BrowserRouter, MemoryRouter, Navigate, Route, Routes, useParams } from 'react-router';

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

import { CredentialsPage } from '../pages/Credentials.js';
import {
  AutomationEditorPage,
  AutomationExecutionDetailPage,
  AutomationExecutionsPage,
  AutomationsPage,
  AutomationVersionsPage,
  FlowsCompatibilityRoute,
  NewAutomationPage,
} from '../pages/AutomationStudio.js';
import { PlatformPage } from '../pages/Platform.js';
import { MetaConnectPage } from '../pages/MetaConnect.js';
import { CompanyPage } from '../pages/Company.js';
import { DashboardPage } from '../pages/Dashboard.js';
import { ProvidersPage } from '../pages/Providers.js';
import { ChannelsPage } from '../pages/Channels.js';
import { ChannelDetailPage } from '../pages/ChannelDetail.js';
import { NewChannelPage } from '../pages/NewChannel.js';
import { ProvisioningPage } from '../pages/Provisioning.js';
import { ReportsPage, BrainPage } from '../pages/Operations.js';
import { OperationalHealthPage } from '../pages/OperationalHealth.js';
import { UsagePage } from '../pages/Usage.js';
import { AuthorizePage } from '../embed/AuthorizePage.js';
import '../embed/embed.css';
import './console.css';
import './broker.css';
import './platform.css';

const browserClient = createApiClient();

function LegacyChannelDetailRedirect() {
  const { id = '' } = useParams();
  return <Navigate replace to={`/channels/${encodeURIComponent(id)}`} />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/embed/authorize" element={<AuthorizePage />} />
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
        <Route path="/providers" element={<Navigate replace to="/channels" />} />
        <Route path="/provisionamento" element={<ProvisioningPage />} />
        <Route path="/health" element={<OperationalHealthPage />} />
        <Route path="/relatorios" element={<ReportsPage />} />
        <Route path="/uso-custos" element={<UsagePage />} />
        <Route path="/brain" element={<BrainPage />} />
        <Route path="/channels" element={<ChannelsPage />} />
        <Route path="/channels/new" element={<NewChannelPage />} />
        <Route path="/channels/meta/connect" element={<MetaConnectPage />} />
        <Route path="/channels/:id" element={<ChannelDetailPage />} />
        <Route path="/legacy/providers" element={<ProvidersPage />} />
        <Route path="/legacy/conexoes" element={<ConnectionsPage />} />
        <Route path="/legacy/conexoes/nova" element={<NewConnectionPage />} />
        <Route path="/legacy/conexoes/:id" element={<ConnectionDetailPage />} />
        <Route path="/conexoes" element={<Navigate replace to="/channels" />} />
        <Route path="/conexoes/nova" element={<Navigate replace to="/channels/new?provider=qr" />} />
        <Route path="/conexoes/:id" element={<LegacyChannelDetailRedirect />} />
        <Route path="/chaves-api" element={<ApiKeysPage />} />
        <Route path="/integracoes" element={<IntegrationsPage />} />
        <Route path="/mensagens" element={<MessagingPage />} />
        <Route path="/automations" element={<AutomationsPage />} />
        <Route path="/automations/new" element={<NewAutomationPage />} />
        <Route path="/automations/:id/edit" element={<AutomationEditorPage />} />
        <Route path="/automations/:id/editor" element={<AutomationEditorPage />} />
        <Route path="/automations/:id/versions" element={<AutomationVersionsPage />} />
        <Route path="/automations/:id/executions" element={<AutomationExecutionsPage />} />
        <Route path="/automation-executions" element={<AutomationExecutionsPage />} />
        <Route path="/automation-executions/:id" element={<AutomationExecutionDetailPage />} />
        <Route path="/credentials" element={<CredentialsPage />} />
        <Route path="/legacy/flows" element={<FlowsCompatibilityRoute />} />
        <Route path="/flows" element={<FlowsCompatibilityRoute />} />
        <Route path="/whatsapp-oficial" element={<Navigate replace to="/channels/meta/connect" />} />
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
