import {useCallback} from 'react';
import {Link} from 'react-router';
import {useApiClient,useSession} from '../auth/SessionProvider.js';
import {DeliveryDiagnostics} from '../integrations/DeliveryDiagnostics.js';

/** The current summary contract is tenant-wide; never imply a channel filter. */
export function ChannelDeliveryDiagnostics(){
 const client=useApiClient(),{session,tenantRevision}=useSession();
 const request=useCallback((path:string)=>client.request('/v1/integrations/chatwoot'+path),[client,session?.activeOrganization.id,tenantRevision]);
 return <section className="panel" aria-label="Evidências de entrega da empresa">
  <h2>Conferir entregas à central</h2>
  <p>Os totais abaixo abrangem toda a empresa, não apenas esta caixa. Sessão conectada e vínculo configurado não comprovam entrega. A consulta é somente leitura.</p>
  <DeliveryDiagnostics request={request}/>
  <p><Link to="/integracoes">Abrir integrações e examinar tarefas</Link>{' · '}<Link to="/mensagens">Conferir mensagens e recibos</Link></p>
 </section>;
}
