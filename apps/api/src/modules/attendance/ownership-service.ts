import { AUTOMATION_ORIGIN, attendanceScopeSchema, ownershipSchema, type AttendanceScope } from '@jrc/contracts';
import type { OrganizationTransaction } from '../../db/tenant-transaction.js';
import { lockAttendanceChannel, resolveAttendanceScope } from './repository.js';
import { lockOwnershipMutations, transitionChannelOwner } from './transition.js';
import { AttendanceError, type ClaimOwnerInput } from './types.js';

export function createOwnershipService(options:{transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>}) {
  async function claim(org:string,channelId:string,input:ClaimOwnerInput,expectedScope?:AttendanceScope) {
    const parsed=ownershipSchema.safeParse({channelId,integrationId:expectedScope?.integrationId??null,revision:input.expectedRevision,
      executor:input.executor,automationId:input.automationId,version:input.version});
    if(!parsed.success)throw new AttendanceError('ATTENDANCE_OWNER_INVALID',422);
    return options.transact(org,async tx=>{
      await lockOwnershipMutations(tx,org);
      await lockAttendanceChannel(tx,org,channelId);
      const scope=await resolveAttendanceScope(tx,org,channelId,input.executor!=='NONE');
      if(expectedScope && (!scope || Object.keys(expectedScope).some(key=>scope[key as keyof AttendanceScope]!==expectedScope[key as keyof AttendanceScope]))) {
        throw new AttendanceError('ATTENDANCE_SCOPE_CHANGED',409);
      }
      if(input.automationId && !(await tx.query('select 1 from automation_versions where organization_id=$1 and automation_id=$2 and version=$3',[org,input.automationId,input.version])).rowCount)throw new AttendanceError('AUTOMATION_VERSION_NOT_FOUND',404);
      const result=await transitionChannelOwner(tx,org,{channelId,botPublicId:input.automationId,botOriginReference:input.automationId?AUTOMATION_ORIGIN:null,
        executor:input.executor,version:input.version??undefined,expectedOwnerRevision:input.expectedRevision});
      return {channelId,integrationId:scope?.integrationId??null,executor:input.executor,automationId:input.automationId,version:input.version,revision:result.ownerRevision};
    });
  }
  return {
    resolveScope:(org:string,channelId:string)=>options.transact(org,async tx=>{
      await lockAttendanceChannel(tx,org,channelId);
      return resolveAttendanceScope(tx,org,channelId);
    }),
    claimChannelOwner:(org:string,channelId:string,input:ClaimOwnerInput)=>claim(org,channelId,input),
    claimInboxOwner:(scope:AttendanceScope,input:ClaimOwnerInput)=>{
      const parsed=attendanceScopeSchema.safeParse(scope);
      if(!parsed.success)return Promise.reject(new AttendanceError('ATTENDANCE_SCOPE_INVALID',422));
      return claim(scope.organizationId,scope.channelId,input,parsed.data);
    },
  };
}
