import {boxTemplateRoutes,BoxDirectorySnapshotSchema,type AutomationGraphV1} from '@jrc/contracts';
/** Called only by the pure simulator. Never imported by the engine, worker or dispatch adapters. */
export function simulationBoxDirectory(graph:AutomationGraphV1){
 const routes=boxTemplateRoutes(graph);if(!routes.length)return undefined;
 return BoxDirectorySnapshotSchema.parse({schemaVersion:1,profileRevision:1,credentialRevision:1,
  scope:{organizationId:'00000000-0000-4000-8000-000000000001',channelId:'00000000-0000-4000-8000-000000000002',integrationId:'00000000-0000-4000-8000-000000000003',accountId:1,inboxId:1,destinationRevision:1},
  routes:routes.map((r,i)=>({routeKey:r.routeKey,teamId:i+1,teamName:`Time fictício ${i+1}`,mode:r.mode,
   agents:r.mode==='TEAM'?[]:[{id:i*10+1,name:'Atendente fictício 1'},{id:i*10+2,name:'Atendente fictício 2'}]}))});
}
