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
  messagesPerDay: "Envios por dia",
  maxPendingMessages: "Mensagens pendentes",
};
export const limitKeys = Object.keys(initialLimits) as (keyof Limits)[];
export const sections = [
  {
    path: "/jrc",
    label: "Dashboard",
    title: "Visão geral",
    description: "Acompanhe as empresas e a operação da JRC em um só lugar.",
    icon: "dashboard",
  },
  {
    path: "/jrc/empresas",
    label: "Empresas",
    title: "Empresas",
    description: "Gerencie seus clientes, responsáveis e canais disponíveis.",
    icon: "providers",
  },
  {
    path: "/jrc/usuarios",
    label: "Usuários e acessos",
    title: "Usuários e acessos",
    description: "Organize os acessos e as permissões de cada empresa.",
    icon: "key",
  },
  {
    path: "/jrc/planos",
    label: "Planos e limites",
    title: "Planos e limites",
    description: "Configure a capacidade contratada por cada cliente.",
    icon: "reports",
  },
  {
    path: "/jrc/monitoramento",
    label: "Monitoramento",
    title: "Health Center",
    description: "Consulte os indicadores operacionais de cada empresa.",
    icon: "health",
  },
  {
    path: "/jrc/suporte",
    label: "Suporte",
    title: "Central de suporte",
    description: "Consulte a operação e registre o atendimento ao cliente.",
    icon: "messages",
  },
] as const;
