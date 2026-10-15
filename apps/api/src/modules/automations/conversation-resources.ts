import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {ActionCatalogPageSchema,ActionResourceWriteSchema,AutomationMediaAssetSchema,AutomationResourceChannelsSchema,ConversationEffectConfigSchema,MediaEffectConfigSchema,validateConversationAttribute,type ActionCatalogPage,type AutomationGraphV1,type ActionResourceWrite,type ConversationAttributeDefinition} from '@jrc/contracts';
import {safeMediaName,type BinaryMedia} from '@jrc/providers';
import type {OrganizationTransaction,TenantTransaction} from '../../db/tenant-transaction.js';
import type {MediaStore} from '../messaging/media-store.js';
import {lockAttendanceChannelRead,resolveAttendanceScope} from '../attendance/repository.js';
import {AutomationError} from './errors.js';
import {assertActionResource,assertMediaAsset,readActionResource,readMediaAsset,sameConversationScope} from './conversation-effects-repository.js';
import {readChatwootAccount} from '../integrations/chatwoot-context.js';
import {readAutomationAccess} from './availability.js';
export interface ConversationCatalogPort{
 refresh(org:string,channel:string):Promise<void>;
}
export interface ConversationResourceOptions{transact<T>(org:string,op:OrganizationTransaction<T>):Promise<T>;media?:Pick<MediaStore,'writeUpload'|'read'>;conversationCatalog?:ConversationCatalogPort;resourceAuthorization?:(tx:TenantTransaction,org:string,root:string,channel:string)=>Promise<void>}
export {ActionResourceWriteSchema};
export type {ActionResourceWrite};
export async function assertConversationResourceScope(tx:TenantTransaction,org:string,root:string,channel:string){
 const access=await readAutomationAccess(tx,org);if(access?.status!=='ACTIVE'||!access.moduleEnabled)throw new AutomationError('AUTOMATION_RESOURCE_ACCESS_DENIED',403);
 await lockAttendanceChannelRead(tx,org,channel);
 const definition=(await tx.query(`select id from automation_definitions where organization_id=$1 and id=$2 and lifecycle_status<>'ARCHIVED' for share`,[org,root])).rows[0];
 const open=(await tx.query<{open:boolean}>('select media_private_channel_open($1,$2) as open',[org,channel])).rows[0]?.open;
 if(!definition||!open)throw new AutomationError('AUTOMATION_RESOURCE_SCOPE_UNAVAILABLE',409);
 return resolveAttendanceScope(tx,org,channel);
}
export async function assertConversationResourcePolicies(tx:TenantTransaction,org:string,root:string,graphs:readonly AutomationGraphV1[],pin?:{automationId:string;version:number}){
 for(const graph of graphs)for(const node of graph.nodes){
  const modern=node.type==='media'?node.data.mediaEffectVersion===2:['tag','attribute','note','resolve'].includes(node.type)&&node.data.conversationEffectVersion===2;if(!modern)continue;
  const config=node.type==='media'?MediaEffectConfigSchema.parse(node.data):ConversationEffectConfigSchema.parse(node.data);
  const scope=await assertConversationResourceScope(tx,org,root,config.channelId);
  if(scope){const catalogue=(await tx.query<{scope:unknown;credentialRevision:number;capabilities:ActionCatalogPage['capabilities'];live:boolean}>(`select scope,credential_revision as "credentialRevision",capabilities,expires_at>clock_timestamp() as live from automation_action_catalogs where organization_id=$1 and channel_id=$2 for share`,[org,config.channelId])).rows[0];
   if(!catalogue?.live||catalogue.credentialRevision!==(await readChatwootAccount(tx,org))?.credential_version||!sameConversationScope(catalogue.scope,scope)||catalogue.capabilities[node.type as keyof ActionCatalogPage['capabilities']]?.state!=='SUPPORTED')throw new AutomationError('AUTOMATION_EFFECT_CAPABILITY_UNAVAILABLE',409);
  }
  if(node.type==='media'){
   const mediaConfig=MediaEffectConfigSchema.parse(config),asset=assertMediaAsset(org,root,config.channelId,mediaConfig,await readMediaAsset(tx,org,mediaConfig.mediaId,true));
   if(pin)await tx.query(`insert into automation_effect_version_pins(organization_id,automation_id,version,node_id,media_asset_id,media_revision) values($1,$2,$3,$4,$5,$6) on conflict do nothing`,[org,pin.automationId,pin.version,node.id,asset.id,asset.revision]);
  }else{const action=ConversationEffectConfigSchema.parse(config);if(action.operation==='tag'||action.operation==='attribute'){
   const row=assertActionResource(org,config.channelId,action,await readActionResource(tx,org,action.resourceId,true));if(row.source!==(scope?'CENTRAL':'LOCAL'))throw new AutomationError('AUTOMATION_RESOURCE_UNAVAILABLE',409);if(action.operation==='attribute'&&action.valueSource.kind==='LITERAL')validateConversationAttribute(row.definition!,action.valueSource.value);
   if(pin)await tx.query(`insert into automation_effect_version_pins(organization_id,automation_id,version,node_id,resource_id,resource_revision) values($1,$2,$3,$4,$5,$6) on conflict do nothing`,[org,pin.automationId,pin.version,node.id,row.id,row.revision]);
  }}
 }
}
const localCapabilities:ActionCatalogPage['capabilities']={tag:{state:'SUPPORTED',reason:null},attribute:{state:'SUPPORTED',reason:null},note:{state:'SUPPORTED',reason:null},resolve:{state:'SUPPORTED',reason:null},media:{state:'SUPPORTED',reason:null}};
export function createConversationResourceService(options:ConversationResourceOptions){
 const assetDto=(org:string,root:string,channel:string,row:Record<string,unknown>)=>AutomationMediaAssetSchema.parse({schemaVersion:1,scope:{organizationId:org,rootAutomationId:root,channelId:channel},...row});
 const authorize=async(tx:TenantTransaction,org:string,root:string,channel:string)=>{
  await options.resourceAuthorization?.(tx,org,root,channel);
  return assertConversationResourceScope(tx,org,root,channel);
 };
 return {
  resourceChannels:(org:string,root:string,input:{pageSize?:number;cursor?:string}={})=>options.transact(org,async tx=>{
   const access=await readAutomationAccess(tx,org);
   if(access?.status!=='ACTIVE'||!access.moduleEnabled)throw new AutomationError('AUTOMATION_RESOURCE_ACCESS_DENIED',403);
   const definition=(await tx.query('select id from automation_definitions where organization_id=$1 and id=$2 and lifecycle_status<>\'ARCHIVED\' for share',[org,root])).rows[0];
   if(!definition)throw new AutomationError('AUTOMATION_RESOURCE_SCOPE_UNAVAILABLE',409);
   const pageSize=z.number().int().min(1).max(200).parse(input.pageSize??25);
   const after=input.cursor?z.uuid().parse(Buffer.from(input.cursor,'base64url').toString('utf8')):null;
   const rows=(await tx.query<{id:string;name:string}>(`select m.id,left(coalesce(nullif(c.name,''),i.name,p.name,'Caixa de entrada'),120) as name
    from messaging_channels m left join chatwoot_connections c on c.organization_id=m.organization_id and c.channel_id=m.id
    left join instances i on i.organization_id=m.organization_id and i.id=m.instance_id
    left join provider_accounts p on p.organization_id=m.organization_id and p.id=m.provider_account_id
    join automation_definitions d on d.organization_id=m.organization_id and d.id=$2
    where m.organization_id=$1 and m.deleting_at is null and (m.instance_id is null or i.archived_at is null)
    and media_private_channel_open($1,m.id) and ($3::uuid is null or m.id>$3)
    and (d.delegation_scope_revision=0 or exists(select 1 from automation_definition_scopes s
      where s.organization_id=m.organization_id and s.automation_id=d.id and s.channel_id=m.id))
    order by m.id limit $4`,[org,root,after,pageSize+1])).rows;
   return AutomationResourceChannelsSchema.parse({schemaVersion:1,scope:{organizationId:org,rootAutomationId:root},
    data:rows.slice(0,pageSize),nextCursor:rows.length>pageSize?Buffer.from(rows[pageSize-1]!.id).toString('base64url'):null});
  }),
  async refreshGraphs(org:string,graphs:readonly AutomationGraphV1[]){const channels=new Set(graphs.flatMap(g=>g.nodes.filter(n=>n.data.conversationEffectVersion!==undefined||n.data.mediaEffectVersion!==undefined).map(n=>String(n.data.channelId))));for(const channel of channels){const scope=await options.transact(org,tx=>resolveAttendanceScope(tx,org,channel));if(scope){if(!options.conversationCatalog)throw new AutomationError('AUTOMATION_EFFECT_CAPABILITY_UNAVAILABLE',409);await options.conversationCatalog.refresh(org,channel);}}},
  async actionCatalog(org:string,root:string,channel:string,input:{pageSize?:number;cursor?:string}={}){
   const scope=await options.transact(org,tx=>authorize(tx,org,root,channel));if(scope&&options.conversationCatalog)await options.conversationCatalog.refresh(org,channel);
   const pageSize=z.number().int().min(1).max(200).parse(input.pageSize??200),cursor=input.cursor?z.uuid().parse(Buffer.from(input.cursor,'base64url').toString('utf8')):null;
   return options.transact(org,async tx=>{const current=await authorize(tx,org,root,channel);let capabilities=localCapabilities;if(current){const cached=(await tx.query<{scope:unknown;credentialRevision:number;capabilities:ActionCatalogPage['capabilities'];live:boolean}>('select scope,credential_revision as "credentialRevision",capabilities,expires_at>clock_timestamp() as live from automation_action_catalogs where organization_id=$1 and channel_id=$2',[org,channel])).rows[0];capabilities=cached?.live&&cached.credentialRevision===(await readChatwootAccount(tx,org))?.credential_version&&sameConversationScope(cached.scope,current)?cached.capabilities:Object.fromEntries(Object.keys(localCapabilities).map(op=>[op,{state:'UNVERIFIED',reason:'CENTRAL_CATALOG_UNVERIFIED'}])) as ActionCatalogPage['capabilities'];}
    if(!options.media)capabilities={...capabilities,media:{state:'UNAVAILABLE',reason:'PRIVATE_STORAGE_UNAVAILABLE'}};
    const rows=(await tx.query<{id:string;name:string;kind:string;revision:string;definition:ConversationAttributeDefinition|null}>(`select id,name,kind,revision,definition from automation_action_resources where organization_id=$1 and channel_id=$2 and source=$3 and status='ACTIVE' and ($4::uuid is null or id>$4) order by id limit $5`,[org,channel,current?'CENTRAL':'LOCAL',cursor,pageSize+1])).rows;
    return ActionCatalogPageSchema.parse({schemaVersion:1,scope:{organizationId:org,rootAutomationId:root,channelId:channel},profile:current?'CENTRAL':'STANDALONE',capabilities,data:rows.slice(0,pageSize),nextCursor:rows.length>pageSize?Buffer.from(rows[pageSize-1]!.id).toString('base64url'):null});});
  },
  saveResource:(org:string,root:string,channel:string,input:ActionResourceWrite)=>options.transact(org,async tx=>{const scope=await authorize(tx,org,root,channel);if(scope)throw new AutomationError('AUTOMATION_CENTRAL_RESOURCE_READ_ONLY',409);const parsed=ActionResourceWriteSchema.parse(input),id=parsed.id??randomUUID(),revision=createHash('sha256').update(JSON.stringify({id,...parsed})).digest('hex');
   const row=parsed.id?(await tx.query(`update automation_action_resources set name=$4,key=$5,kind=$6,definition=$7::jsonb,status=$8,revision=$9,edit_revision=edit_revision+1,updated_at=now() where organization_id=$1 and channel_id=$2 and id=$3 and source='LOCAL' and edit_revision=$10 returning id,name,key,kind,definition,status,revision,edit_revision as "editRevision"`,[org,channel,id,parsed.name,parsed.key,parsed.kind,JSON.stringify(parsed.definition),parsed.status,revision,parsed.editRevision])).rows[0]:(await tx.query(`insert into automation_action_resources(organization_id,channel_id,id,source,name,key,kind,definition,status,revision) values($1,$2,$3,'LOCAL',$4,$5,$6,$7::jsonb,$8,$9) returning id,name,key,kind,definition,status,revision,edit_revision as "editRevision"`,[org,channel,id,parsed.name,parsed.key,parsed.kind,JSON.stringify(parsed.definition),parsed.status,revision])).rows[0];if(!row)throw new AutomationError('AUTOMATION_RESOURCE_CHANGED',409);return row;
  }),
  async uploadMedia(org:string,root:string,channel:string,input:BinaryMedia&{idempotencyKey:string}){
   if(!options.media)throw new AutomationError('AUTOMATION_MEDIA_UNAVAILABLE',503);z.uuid().parse(input.idempotencyKey);
   const bytes=new Uint8Array(input.bytes),name=safeMediaName(input.fileName),file={...input,bytes,fileName:name};
   const authorizeUpload=async(tx:Pick<TenantTransaction,'query'>)=>{await authorize(tx as TenantTransaction,org,root,channel);};
   await options.transact(org,authorizeUpload);
   const mediaId=await options.media.writeUpload(org,channel,{rootAutomationId:root,idempotencyKey:input.idempotencyKey},file,{authorize:authorizeUpload});
   return options.transact(org,async tx=>{await authorizeUpload(tx);const media=(await tx.query<{status:string;sha256:string;byteSize:number;mimeType:string}>('select status,sha256,byte_size as "byteSize",mime_type as "mimeType" from messaging_media where organization_id=$1 and channel_id=$2 and id=$3',[org,channel,mediaId])).rows[0];if(!media?.sha256)throw new AutomationError('AUTOMATION_MEDIA_UNAVAILABLE',409);
    const hash=createHash('sha256').update(JSON.stringify({root,channel,sha256:media.sha256,name,kind:input.kind,mime:input.mimeType})).digest('hex');
    const row=(await tx.query<Record<string,unknown>>(`insert into automation_media_assets(organization_id,root_automation_id,channel_id,media_id,name,kind,idempotency_key,request_hash,status) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(organization_id,root_automation_id,channel_id,idempotency_key) do update set idempotency_key=automation_media_assets.idempotency_key returning id,revision,status,name,kind,request_hash as "requestHash"`,[org,root,channel,mediaId,name,input.kind,input.idempotencyKey,hash,media.status==='READY'?'READY':'STORING'])).rows[0]!;
    if(row.requestHash!==hash||row.status==='REVOKED')throw new AutomationError('AUTOMATION_MEDIA_UPLOAD_CONFLICT',409);delete row.requestHash;row.status=media.status==='READY'?'READY':'STORING';return assetDto(org,root,channel,{...row,mimeType:media.mimeType,byteSize:media.byteSize});});
  },
  mediaCatalog:(org:string,root:string,channel:string)=>options.transact(org,async tx=>{await assertConversationResourceScope(tx,org,root,channel);const rows=(await tx.query<Record<string,unknown>>(`select a.id,a.revision,case when a.status='REVOKED' then 'REVOKED' when m.status='READY' then 'READY' else 'STORING' end as status,a.name,a.kind,m.mime_type as "mimeType",m.byte_size as "byteSize" from automation_media_assets a join messaging_media m on m.organization_id=a.organization_id and m.id=a.media_id where a.organization_id=$1 and a.root_automation_id=$2 and a.channel_id=$3 order by a.created_at desc,a.id limit 200`,[org,root,channel])).rows;return {schemaVersion:1,scope:{organizationId:org,rootAutomationId:root,channelId:channel},data:rows.map(row=>assetDto(org,root,channel,row))};}),
  revokeMedia:(org:string,root:string,channel:string,id:string,revision:number)=>options.transact(org,async tx=>{await assertConversationResourceScope(tx,org,root,channel);const row=(await tx.query('update automation_media_assets set status=\'REVOKED\',revision=revision+1 where organization_id=$1 and root_automation_id=$2 and channel_id=$3 and id=$4 and revision=$5 returning id',[org,root,channel,id,revision])).rows[0];if(!row)throw new AutomationError('AUTOMATION_MEDIA_CHANGED',409);return {ok:true};}),
 };
}
