import type {Pool} from 'pg';
import {createFlowCredentialResolver} from './runtime.js';
import {createNativeFlowAdapter,type NativeAdapterOptions} from './native-adapter.js';
import type {NativeFlowRouteOptions} from '../../../http/routes/flow-native.js';
import {createNativeRegistrationRuntime} from './registration/runtime.js';
import {createNativeInstallationService} from './installation/service.js';
import {createInstallationVerifier} from './installation/adapter.js';
import {createNativeReopenProof} from './broker-reopen-proof.js';
export interface NativeFlowRuntimeOptions {
 authPool:Pick<Pool,'query'>;
 authentication:Pick<NativeFlowRouteOptions,'jwtSecret'|'authenticateApiKey'|'resolveCurrentRole'>;
 rateLimit:NativeFlowRouteOptions['rateLimit'];
 resolveRegistration?:NativeAdapterOptions['resolveRegistration'];
 registration?:Omit<Parameters<typeof createNativeRegistrationRuntime>[0],'service'>;
}
/** Explicit existing vault keyring enables the dedicated repository; absence
 * denies introspection and never supplies native readiness. */
export function createNativeFlowRuntime(options:NativeFlowRuntimeOptions){
 let configured:ReturnType<typeof createNativeRegistrationRuntime>|undefined;
 const adapter=createNativeFlowAdapter({resolveRegistration:options.resolveRegistration??(async(context,signal)=>configured?configured.resolveRegistration(context,signal):null)});
 const resolveFlowCredential=createFlowCredentialResolver(options.authPool);
 const resolveInstallationGrant=async(digest:string):Promise<string|null>=>{if(!/^[a-f0-9]{64}$/.test(digest))return null;const row=(await options.authPool.query<{organization_id:string|null}>('SELECT resolve_flow_installation_grant($1) AS organization_id',[digest])).rows[0];return row?.organization_id??null;};
 const resolveInstallationReduction=async(digest:string):Promise<string|null>=>{if(!/^[a-f0-9]{64}$/.test(digest))return null;const row=(await options.authPool.query<{organization_id:string|null}>('SELECT resolve_flow_installation_reduction($1) AS organization_id',[digest])).rows[0];return row?.organization_id??null;};
 return {adapter,routesFor:(service:NativeFlowRouteOptions['service']):NativeFlowRouteOptions=>{if(options.registration)configured=createNativeRegistrationRuntime({...options.registration,service});
  const installation=options.registration?createNativeInstallationService({...options.registration,service,verifyHost:createInstallationVerifier()}):undefined;
  const reopenProof=options.registration?createNativeReopenProof({transact:options.registration.transact,authorize:service.nativeRegistrationAuthority}):undefined;
  return {...options.authentication,service,resolveFlowCredential,rateLimit:options.rateLimit,...(configured?{registration:configured.registration}:{}),...(installation?{installation,resolveInstallationGrant,resolveInstallationReduction}:{}),...(reopenProof?{reopenProof}:{})};}};
}
