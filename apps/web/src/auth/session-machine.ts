import type {
  LoginRequest,
  OrganizationSummary,
} from '@jrc/contracts';

import type { BrowserSession } from '../api/client.js';

export type SessionStatus = 'booting' | 'anonymous' | 'selecting' | 'authenticated' | 'expired';

export interface SessionNotice {
  message: string;
  requestId?: string;
}

export interface SessionContextValue {
  status: SessionStatus;
  session: BrowserSession | null;
  tenantRevision: number;
  selectionOrganizations: OrganizationSummary[];
  selectionPending: boolean;
  switchPending: boolean;
  notice: SessionNotice | null;
  login(input: LoginRequest): Promise<void>;
  selectOrganization(organizationId: string): Promise<void>;
  switchOrganization(organizationId: string): Promise<void>;
  logout(): Promise<void>;
}
