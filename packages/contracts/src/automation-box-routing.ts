import {z} from 'zod';
import {attendanceScopeSchema} from './attendance-v1.js';
import type {FlowGraph} from './flows.js';
import {attendanceCatalogSchema} from './attendance-catalog.js';

const id=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const key=z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).refine(v=>!['constructor','prototype'].includes(v));
const label=z.string().trim().min(1).max(120).refine(v=>!/[\r\n\u0000-\u001f]/u.test(v));
const unique=<T>(items:T[])=>new Set(items).size===items.length;
export const BoxRouteSchema=z.strictObject({routeKey:key,labels:z.strictObject({pt:label,en:label}),mode:z.enum(['AGENT','TEAM'])});
export const BoxRoutesSchema=z.array(BoxRouteSchema).min(1).max(20).refine(v=>unique(v.map(r=>r.routeKey)),'Rotas duplicadas.');
/** Logical template reference. Never accepted as a canonical external handoff. */
export const RouteHandoffV3Schema=z.strictObject({handoffVersion:z.literal(3),routeKey:key});
export const DirectoryMenuSchema=z.strictObject({directoryVersion:z.literal(1),routeKey:key,language:z.enum(['pt','en']),
 text:z.string().trim().min(1).max(2048),backLabel:label,errorMessage:z.string().trim().min(1).max(512),
 maxAttempts:z.number().int().min(1).max(100),timeoutSeconds:z.number().int().min(1).max(604800).optional()});
export const BoxRoutingConfigSchema=z.strictObject({schemaVersion:z.literal(1),routes:z.array(z.strictObject({
 routeKey:key,teamId:id,mode:z.enum(['AGENT','TEAM']),membership:z.enum(['ALL','SELECTED']),agentIds:z.array(id).max(9).refine(unique),
})).min(1).max(20).refine(v=>unique(v.map(r=>r.routeKey)),'Rotas duplicadas.')}).superRefine((v,c)=>{
 for(const [i,r] of v.routes.entries())if(r.membership==='ALL'&&r.agentIds.length||r.mode==='TEAM'&&r.agentIds.length||r.mode==='AGENT'&&r.membership==='SELECTED'&&!r.agentIds.length)
  c.addIssue({code:'custom',path:['routes',i,'agentIds'],message:'Seleção de agentes incompatível com o modo.'});
});
export const BoxDirectorySnapshotSchema=z.strictObject({schemaVersion:z.literal(1),profileRevision:id,scope:attendanceScopeSchema,credentialRevision:id,
 routes:z.array(z.strictObject({routeKey:key,teamId:id,teamName:label,mode:z.enum(['AGENT','TEAM']),
  agents:z.array(z.strictObject({id,name:label,optionValue:z.string().regex(/^(?:[1-9]|10)$/).optional()})).max(9).refine(v=>unique(v.map(a=>a.id))),
  backValue:z.string().regex(/^(?:[1-9]|10)$/).optional(),
 }).superRefine((r,c)=>{const values=r.agents.map((a,i)=>a.optionValue??String(i+1)),back=r.backValue??String(r.agents.length+1);
  if(!unique(values)||values.includes(back))c.addIssue({code:'custom',message:'As opções do snapshot devem ser únicas.'});
 })).min(1).max(20).refine(v=>unique(v.map(r=>r.routeKey)))});
export type BoxRoutingConfig=z.infer<typeof BoxRoutingConfigSchema>;
export type BoxDirectorySnapshot=z.infer<typeof BoxDirectorySnapshotSchema>;
export type BoxRoute=z.infer<typeof BoxRouteSchema>;
export const BoxProfileSchema=z.strictObject({organizationId:z.uuid(),automationId:z.uuid(),version:id,channelId:z.uuid(),revision:id,activeRevision:id.nullable(),config:BoxRoutingConfigSchema,snapshot:BoxDirectorySnapshotSchema});
export const BoxRoutingCatalogSchema=z.strictObject({schemaVersion:z.literal(1),scope:z.strictObject({organizationId:z.uuid(),automationId:z.uuid(),version:id,channelId:z.uuid()}),
 routes:z.array(BoxRouteSchema).max(20),catalog:attendanceCatalogSchema,
 teamMembers:z.array(z.strictObject({teamId:id,agents:z.array(z.strictObject({id,name:z.string().max(1000)})).max(10000)})).max(10000),
 profile:BoxProfileSchema.nullable(),rulesCheck:z.literal('UNVERIFIED')});
export type BoxRoutingCatalog=z.infer<typeof BoxRoutingCatalogSchema>;

export function boxTemplateRoutes(graph:FlowGraph):BoxRoute[]{
 const raw=graph.nodes.find(n=>n.type==='start')?.data.boxRoutes;
 const uses=graph.nodes.some(n=>n.type==='directory-menu'||n.type==='handoff'&&n.data.handoffVersion===3);
 if(raw===undefined){if(uses)throw Error('FLOW_BOX_ROUTES_REQUIRED');return [];}
 const routes=BoxRoutesSchema.parse(raw);
 // Static destinations in a reusable model, including opaque subflows, cannot be rebound safely.
 if(graph.nodes.some(n=>n.type==='subflow'||n.type==='handoff'&&n.data.handoffVersion!==3))throw Error('FLOW_BOX_TEMPLATE_MIXED_DESTINATIONS');
 for(const node of graph.nodes){
  if(node.type!=='directory-menu'&&!(node.type==='handoff'&&node.data.handoffVersion===3))continue;
  const config=node.type==='directory-menu'?DirectoryMenuSchema.parse(node.data):RouteHandoffV3Schema.parse(node.data);
  const route=routes.find(r=>r.routeKey===config.routeKey);if(!route||node.type==='directory-menu'&&route.mode!=='AGENT')throw Error('FLOW_BOX_ROUTE_UNAVAILABLE');
 }
 if(routes.some(r=>!graph.nodes.some(n=>n.type==='handoff'&&n.data.handoffVersion===3&&n.data.routeKey===r.routeKey)))throw Error('FLOW_BOX_ROUTE_UNUSED');
 return routes;
}
