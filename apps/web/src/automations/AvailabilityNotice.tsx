export interface AutomationAvailability {
 enabled:boolean;canRead?:boolean;canEdit?:boolean;canSimulate?:boolean;canPublish?:boolean;reasons?:string[];
}
const messages:Record<string,string>={
 AUTOMATION_RUNTIME_DISABLED:'A execução de bots está pausada pela administração JRC. Publicar e ativar dependem da liberação do serviço.',
 AUTOMATION_MODULE_DISABLED:'O módulo Flow não está habilitado no plano desta empresa. Os rascunhos e o histórico continuam disponíveis para consulta. Solicite a habilitação à administração JRC.',
 ORGANIZATION_NOT_ACTIVE:'Esta empresa está desativada ou suspensa. As automações estão disponíveis para consulta; reative a empresa para voltar a editar e operar.',
 AUTOMATION_PERMISSION_REQUIRED:'Seu acesso permite consultar automações. Somente o proprietário e administradores da empresa podem editar, testar e publicar.',
 AUTOMATION_DEPENDENCY_UNAVAILABLE:'A execução está indisponível porque uma dependência ou worker precisa de atenção. Consulte Saúde operacional antes de publicar.',
};
export function AutomationAvailabilityNotice({status}:{status:AutomationAvailability|null}){
 if(!status)return null;
 const reasons=status.reasons??(status.enabled?[]:['AUTOMATION_RUNTIME_DISABLED']);
 if(!reasons.length)return null;
 return <div role="status" className="flows-alert automation-availability">{reasons.map(reason=><p key={reason}>{messages[reason]??'A operação precisa de atenção da administração JRC.'}</p>)}{status.canEdit&&<p>Você pode preparar rascunhos e testar a conversa enquanto a execução está indisponível.</p>}</div>;
}
