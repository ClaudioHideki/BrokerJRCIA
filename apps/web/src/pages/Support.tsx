import { useApiClient, useSession } from '../auth/SessionProvider.js';
import { SupportDesk, type SupportRequest } from '../support/SupportDesk.js';
export function SupportPage() {
  const client=useApiClient(),{session}=useSession();
  if(!session)return null;
  const request:SupportRequest=(path,method='GET',body)=>client.request(path,{method,...(body===undefined?{}:{body:JSON.stringify(body)})});
  return <SupportDesk key={session.activeOrganization.id} scopeKey={session.activeOrganization.id} request={request} canWrite={session.activeOrganization.role!=='VIEWER'}/>;
}
