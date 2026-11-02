export interface StaffSession {
  user: { id: string; email: string; role: "SUPER_ADMIN" | "SUPPORT" };
  csrfToken: string;
  expiresAt: string;
}
export interface Limits {
  maxInstances: number;
  maxUsers: number;
  messagesPerDay: number;
  maxPendingMessages: number;
}
export interface Company {
  id: string;
  name: string;
  slug: string;
  status: "ACTIVE" | "SUSPENDED" | "DISABLED";
  plan: string;
  flowsEnabled?: boolean;
  limits?: Limits;
}
export interface Member {
  userId: string;
  email: string;
  role: string;
  status: string;
}
export interface Monitor {
  connections: number;
  queue: number;
  failures: number;
  webhooks: number;
}
export const statusLabels = {
  ACTIVE: "Ativa",
  SUSPENDED: "Suspensa",
  DISABLED: "Desativada",
};
export const roleLabels: Record<string, string> = {
  OWNER: "Responsável",
  ADMIN: "Administrador",
  OPERATOR: "Operador",
  VIEWER: "Leitor",
};
export const initialLimits: Limits = {
  maxInstances: 5,
  maxUsers: 10,
  messagesPerDay: 1000,
  maxPendingMessages: 1000,
};
export const limitLabels = {
  maxInstances: "Conexões",
  maxUsers: "Usuários",
  messagesPerDay: "Mensagens aceitas por dia UTC",
  maxPendingMessages: "Mensagens pendentes",
};
export const limitKeys = Object.keys(initialLimits) as (keyof Limits)[];
export { platformNavigation as sections } from '../layout/navigation.js';
