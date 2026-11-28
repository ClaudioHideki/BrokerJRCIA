import { z } from 'zod';
export interface DirectSourcePolicy {
  directSourceGuardIntegrations?: ReadonlySet<string>;
  directTransportReviewIntegrations?: ReadonlySet<string>;
}
export function guardDirectSource(policy:DirectSourcePolicy,integrationId:string) {
  return policy.directSourceGuardIntegrations?.has(integrationId)===true || policy.directTransportReviewIntegrations?.has(integrationId)===true;
}
// A reserved marker can veto egress. It cannot authenticate a successful mirror.
export function hasBrokerMirrorMarker(attrs:Record<string,unknown>|undefined) {
  return attrs?.jrc_broker_message_id!=null;
}

export function railsDeleted(attrs:Record<string,unknown>|undefined) {
  const value=attrs?.deleted;
  return value!==undefined && value!==false && value!=='false';
}

// Legacy Rails json and jsonb columns can contain one JSON-encoded object.
export const railsAttributes=z.preprocess(value=>{
  if(typeof value!=='string')return value;
  try{return JSON.parse(value);}catch{return null;}
},z.record(z.string(),z.unknown()));
