/** Page discovery only. Runtime capability and server authorization remain authoritative. */
export type TenantRole = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';
type NavigationPermission = 'member:read' | 'api_keys:manage';
export interface TenantNavigationItem {
  id: string;
  context: 'tenant';
  path: string;
  label: string;
  description: string;
  section: string;
  icon: string;
  permission: NavigationPermission;
  availability: 'available';
  keywords: readonly string[];
  external?: boolean;
}
const item = (value: Omit<TenantNavigationItem,'context'|'availability'|'permission'> & {permission?: NavigationPermission}): TenantNavigationItem =>
  ({...value,context:'tenant',availability:'available',permission:value.permission ?? 'member:read'});

export const tenantNavigation: readonly TenantNavigationItem[] = [
  item({id:'overview',path:'/dashboard',label:'Dashboard',description:'Visão geral da empresa e ações operacionais.',section:'Visão geral',icon:'dashboard',keywords:['visão geral','indicadores']}),
  item({id:'channels',path:'/channels',label:'Conexões e caixas',description:'Selecione a conexão para conferir WhatsApp, caixa, identidade e automação.',section:'Atendimento',icon:'connections',keywords:['whatsapp','qr code','meta','caixas de entrada','grupos','histórico']}),
  item({id:'provisioning',path:'/provisionamento',label:'Provisionamento',description:'Importação e criação assistida de conexões.',section:'Atendimento',icon:'upload',keywords:['importar conexões','lote']}),
  item({id:'messages',path:'/mensagens',label:'Conversas',description:'Mensagens, atendimento e recibos da empresa.',section:'Atendimento',icon:'messages',keywords:['mensagens','mídia','anexos','entrega']}),
  item({id:'automations',path:'/automations',label:'Flows e automações',description:'Editor, versões, instalações e execuções de automação.',section:'Atendimento',icon:'brain',keywords:['bots','fluxos','ura','handoff']}),
  item({id:'integrations',path:'/integracoes',label:'Integrações',description:'Destinos, contas e vínculos de atendimento autorizados.',section:'Integrações',icon:'globe',keywords:['chatwoot','jrc conversas','inbox','callback']}),
  item({id:'api',path:'/api-webhooks',label:'API e webhooks',description:'Guia dos modos de integração, contratos e documentação pública.',section:'API e webhooks',icon:'globe',keywords:['swagger','postman','documentação','parceiro','cclx']}),
  item({id:'api-keys',path:'/chaves-api',label:'Chaves de API',description:'Emitir e revogar credenciais técnicas da empresa com escopos.',section:'API e webhooks',icon:'key',permission:'api_keys:manage',keywords:['token','escopos','credenciais de api']}),
  item({id:'health',path:'/operations/health',label:'Saúde operacional',description:'Estado observado dos componentes e alertas da operação.',section:'Monitoramento',icon:'health',keywords:['monitoramento','saúde','filas','atrasos']}),
  item({id:'reports',path:'/relatorios',label:'Relatórios',description:'Indicadores e relatórios operacionais.',section:'Monitoramento',icon:'reports',keywords:['métricas','resultados']}),
  item({id:'usage',path:'/uso-custos',label:'Uso e custos',description:'Consumo e custos registrados da empresa.',section:'Monitoramento',icon:'costs',keywords:['quota','limites','consumo']}),
  item({id:'brain',path:'/brain',label:'Diagnóstico por regras',description:'JRC Brain: diagnóstico operacional por regras, sem promessa de IA generativa.',section:'Monitoramento',icon:'brain',keywords:['jrc brain','diagnóstico','regras']}),
  item({id:'settings',path:'/configuracoes',label:'Configurações',description:'Encontre a configuração no escopo da empresa, conexão ou integração.',section:'Configurações',icon:'settings',keywords:['preferências','configurar','segurança']}),
  item({id:'company',path:'/minha-empresa',label:'Minha empresa e limites',description:'Status da empresa e limites efetivos consultados do servidor.',section:'Configurações',icon:'providers',keywords:['plano','empresa','limites']}),
  item({id:'credentials',path:'/credentials',label:'Credenciais',description:'Metadados e políticas de credenciais de automação; gestão conforme o papel.',section:'Configurações',icon:'key',keywords:['segredos','http','ia','automação']}),
  item({id:'support',path:'/suporte',label:'Suporte',description:'Solicitar atendimento à equipe JRC.',section:'Configurações',icon:'messages',keywords:['ajuda','suporte']}),
];

function searchable(value: string) {
  return value.normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR').trim();
}
function matchesQuery(entry: {label:string;description:string;keywords?:readonly string[]}, query:string) {
  const haystack=searchable([entry.label,entry.description,...entry.keywords??[]].join(' '));
  return searchable(query).split(/\s+/u).filter(Boolean).every(term=>haystack.includes(term));
}
export function tenantNavigationFor(role: TenantRole, query = ''): readonly TenantNavigationItem[] {
  return tenantNavigation.filter(entry =>
    (entry.permission !== 'api_keys:manage' || role === 'OWNER' || role === 'ADMIN') &&
    matchesQuery(entry,query));
}

export const platformNavigation = [
  {id:'platform-overview',context:'platform',section:'Plataforma',path:'/jrc',label:'Dashboard',title:'Visão geral',description:'Acompanhe as empresas e a operação da JRC em um só lugar.',icon:'dashboard',permission:'staff:read',availability:'available'},
  {id:'platform-groups',context:'platform',section:'Plataforma',path:'/jrc/grupos',label:'Grupos econômicos',title:'Grupos econômicos',description:'Organize empresas sem compartilhar dados ou permissões entre elas.',icon:'providers',permission:'staff:read',availability:'available'},
  {id:'platform-companies',context:'platform',section:'Plataforma',path:'/jrc/empresas',label:'Empresas',title:'Empresas',description:'Gerencie seus clientes, responsáveis e canais disponíveis.',icon:'providers',permission:'staff:read',availability:'available'},
  {id:'platform-users',context:'platform',section:'Plataforma',path:'/jrc/usuarios',label:'Usuários e acessos',title:'Usuários e acessos',description:'Organize os acessos e as permissões de cada empresa.',icon:'key',permission:'staff:read',availability:'available'},
  {id:'platform-plans',context:'platform',section:'Plataforma',path:'/jrc/planos',label:'Planos e limites',title:'Planos e limites',description:'Configure a capacidade contratada por cada cliente.',icon:'reports',permission:'staff:read',availability:'available'},
  {id:'platform-monitoring',context:'platform',section:'Plataforma',path:'/jrc/monitoramento',label:'Monitoramento',title:'Health Center',description:'Consulte os indicadores operacionais de cada empresa.',icon:'health',permission:'staff:read',availability:'available'},
  {id:'platform-support',context:'platform',section:'Plataforma',path:'/jrc/suporte',label:'Suporte',title:'Central de suporte',description:'Consulte a operação e registre o atendimento ao cliente.',icon:'messages',permission:'staff:read',availability:'available'},
] as const;

export function platformNavigationFor(query = '') {
  return platformNavigation.filter(entry=>matchesQuery(entry,query));
}

export const navigationRegistry = [...tenantNavigation,...platformNavigation] as const;

export function tenantPageFor(pathname: string, role: TenantRole) {
  let path=pathname.replace(/\/$/u,'');
  if(path==='/providers'||path.startsWith('/conexoes'))path='/channels'+path.slice(path.startsWith('/conexoes')?9:path.length);
  if(path==='/flows'||path.startsWith('/legacy/flows'))path='/automations';
  if(path==='/whatsapp-oficial')path='/channels/meta/connect';
  if(path.startsWith('/automation-executions'))path='/automations/executions';
  return tenantNavigationFor(role).filter(entry=>path===entry.path||path.startsWith(entry.path+'/'))
    .sort((a,b)=>b.path.length-a.path.length)[0];
}
