import { useApiClient,useSession } from '../auth/SessionProvider.js';
import { PageHeading } from '../broker/components.js';
import { ChatwootPanel } from '../integrations/ChatwootPanel.js';
export function IntegrationsPage(){
 const client=useApiClient(),{session,tenantRevision}=useSession();
 if(!session)return null;
 return <><PageHeading title="JRC Conversas" description="Conecte os canais da sua empresa à sua central de atendimento."/>
  <ChatwootPanel key={session.activeOrganization.id+':'+tenantRevision} companyName={session.activeOrganization.name}
   canManage={['OWNER','ADMIN'].includes(session.activeOrganization.role)} platform={false}
   request={(path,method='GET',body)=>client.request('/v1/integrations/chatwoot'+path,{method,...(body===undefined?{}:{body:JSON.stringify(body)})})}/></>;
}
