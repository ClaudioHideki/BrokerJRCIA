import { GroupCatalogError, type GroupCatalogPrincipal } from './service.js';
import type { OrganizationTransaction,TenantTransaction } from '../../db/tenant-transaction.js';
import type { ProviderContext } from '@jrc/providers';
import { createHmac,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WhatsAppGroupEventsConfigurationSchema,type WhatsAppGroupEventsConfiguration } from '@jrc/contracts';
import { requireActiveOrganization,TenantOperationalError } from '../tenancy/operational-limits.js';
import { lockAttendanceChannel } from '../attendance/repository.js';
export interface GroupWebhookOptions {
  encryptionKey: string; configurationScope: string;
  transact<T>(org: string, work: OrganizationTransaction<T>): Promise<T>;
  readIdentity(context: ProviderContext, instanceKey: string): Promise<{ connected:boolean;phone:string|null }>;
  readConfiguration(context: ProviderContext, instanceKey: string, org: string, channel: string): Promise<'MATCHING'|'MISMATCHED'|'MISSING'>;
  setConfiguration(context: ProviderContext, instanceKey: string, org: string, channel: string): Promise<void>;
}
interface Channel { instance_id:string;upstream_instance_key:string;connected:boolean }
interface Catalog { identity_revision:string;identity_fingerprint:string|null;catalog_revision:string;last_error_code:string|null }
interface Operation { id:string;phase:'PREPARED'|'DISPATCHED'|'UNKNOWN'|'CONFIRMED';binding_fingerprint:string;
  identity_revision:string|null;identity_fingerprint:string|null;expected_identity_revision:string;catalog_revision:string;
  lease_token:string|null;lease_expires_at:Date|null;observed_at:Date|null;updated_at:Date;safe_error:WhatsAppGroupEventsConfiguration['safeError'] }
export function createWhatsAppGroupWebhookConfiguration(options: GroupWebhookOptions) {
  const key=Buffer.from(options.encryptionKey,'base64');
  if(key.length!==32||key.toString('base64')!==options.encryptionKey||!options.configurationScope)throw new Error('INVALID_INTEGRATION_ENCRYPTION_KEY');
  const hash=(domain:string,value:string)=>createHmac('sha256',key).update(`${domain}\0${value}`).digest('hex');
  const binding=(org:string,channel:string,current:Channel)=>hash('whatsapp-group-webhook-binding:v2',
    JSON.stringify([options.configurationScope,org,channel,current.instance_id,current.upstream_instance_key]));
  const identity=(org:string,channel:string,phone:string)=>createHmac('sha256',key).update(`whatsapp-group-identity:v1:${org}:${channel}:${phone}`).digest('hex');
  async function access(tx:TenantTransaction,p:GroupCatalogPrincipal,channel:string,write:boolean):Promise<Channel>{
    z.uuid().parse(channel);z.uuid().parse(p.organizationId);z.uuid().parse(p.actorId);
    await requireActiveOrganization(tx,p.organizationId);
    const member=(await tx.query<{role:string}>('SELECT role FROM lock_local_attendance_member($1)',[p.actorId])).rows[0];
    if(!member||write&&!['OWNER','ADMIN'].includes(member.role))throw new GroupCatalogError('GROUP_ACCESS_DENIED',403);
    try{await lockAttendanceChannel(tx,p.organizationId,channel);}catch(error){
      if((error as {code?:unknown})?.code==='CHANNEL_NOT_FOUND')throw new GroupCatalogError('GROUP_CHANNEL_NOT_FOUND',404);throw error;}
    const row=(await tx.query<Channel>(`SELECT c.instance_id,i.upstream_instance_key,i.status='CONNECTED' AS connected
      FROM messaging_channels c JOIN instances i ON i.organization_id=c.organization_id AND i.id=c.instance_id
      WHERE c.organization_id=$1 AND c.id=$2 AND c.provider='BAILEYS' AND c.deleting_at IS NULL AND i.archived_at IS NULL`,[p.organizationId,channel])).rows[0];
    if(!row)throw new GroupCatalogError('GROUP_CHANNEL_NOT_FOUND',404);return row;
  }
  const catalog=async(tx:TenantTransaction,org:string,channel:string)=>(await tx.query<Catalog>(
    'SELECT identity_revision,identity_fingerprint,catalog_revision,last_error_code FROM whatsapp_group_catalogs WHERE organization_id=$1 AND channel_id=$2 FOR UPDATE',[org,channel])).rows[0];
  const latest=async(tx:TenantTransaction,org:string,channel:string)=>(await tx.query<Operation>(`SELECT * FROM whatsapp_group_webhook_operations
    WHERE organization_id=$1 AND channel_id=$2 ORDER BY (phase IN ('PREPARED','DISPATCHED','UNKNOWN')) DESC,created_at DESC,id DESC LIMIT 1 FOR UPDATE`,[org,channel])).rows[0];
  async function cleanup(org:string,channel:string,id:string,lease:string,safe:Operation['safe_error']){
    await options.transact(org,async tx=>{
      // Only ledger/lease cleanup; no remote mutation, catalog promotion or grant.
      await lockAttendanceChannel(tx,org,channel);
      await tx.query(`UPDATE whatsapp_group_webhook_operations SET phase=CASE WHEN phase IN ('DISPATCHED','UNKNOWN') THEN 'UNKNOWN' ELSE phase END,
        lease_token=NULL,lease_expires_at=NULL,safe_error=$5,updated_at=clock_timestamp()
        WHERE organization_id=$1 AND channel_id=$2 AND id=$3 AND lease_token=$4`,[org,channel,id,lease,safe]);
      if(safe==='IDENTITY_CHANGED'){
        await tx.query(`UPDATE whatsapp_group_catalogs SET last_error_code='IDENTITY_CHANGED',lease_token=NULL,lease_expires_at=NULL,
          catalog_revision=catalog_revision+CASE WHEN snapshot_id IS NULL THEN 0 ELSE 1 END,updated_at=clock_timestamp() WHERE organization_id=$1 AND channel_id=$2`,[org,channel]);
        await tx.query('UPDATE whatsapp_group_catalog_items SET selected=false WHERE organization_id=$1 AND channel_id=$2',[org,channel]);
      }
    }).catch(()=>{}); // Lifecycle may already have purged the nominated channel.
  }
  async function status(p:GroupCatalogPrincipal,channel:string):Promise<WhatsAppGroupEventsConfiguration>{
    return options.transact(p.organizationId,async tx=>{
      const current=await access(tx,p,channel,false),c=await catalog(tx,p.organizationId,channel),op=await latest(tx,p.organizationId,channel);
      const unknown=op&&['DISPATCHED','UNKNOWN'].includes(op.phase);
      const matching=op&&op.binding_fingerprint===binding(p.organizationId,channel,current)&&current.connected
        &&c&&op.identity_revision===c.identity_revision&&(!c.identity_fingerprint||op.identity_fingerprint===c.identity_fingerprint)
        &&c.last_error_code!=='IDENTITY_CHANGED';
      const state=!op||op.phase==='PREPARED'?'UNCONFIGURED':unknown?'UNKNOWN':matching?'CONFIRMED':'STALE';
      return WhatsAppGroupEventsConfigurationSchema.parse({schemaVersion:1,organizationId:p.organizationId,channelId:channel,
        status:state,operationId:op?.id??null,configurationRevision:2,observedAt:op?.observed_at?.toISOString()??null,
        updatedAt:op?.updated_at.toISOString()??null,observedIdentityRevision:op?.identity_revision?Number(op.identity_revision):null,
        observedCatalogRevision:op&&Number(op.catalog_revision)>0?Number(op.catalog_revision):null,
        safeError:state==='CONFIRMED'?null:op?.safe_error??(state==='STALE'?'IDENTITY_CHANGED':null),
        nextAction:unknown?'RECONCILE_READ_ONLY':'UPDATE_GROUPS'});
    });
  }
  return {
    status,
    async ensure(p:GroupCatalogPrincipal,channel:string):Promise<void>{
      const org=p.organizationId,lease=randomUUID();
      const captured=await options.transact(org,async tx=>{
        const current=await access(tx,p,channel,true);
        if(!current.connected)throw new GroupCatalogError('GROUP_CHANNEL_DISCONNECTED');
        await tx.query('INSERT INTO whatsapp_group_catalogs(organization_id,channel_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[org,channel]);
        const c=(await catalog(tx,org,channel))!,previous=await latest(tx,org,channel);
        if(previous?.lease_token){const busy=(await tx.query('SELECT lease_expires_at>clock_timestamp() AS busy FROM whatsapp_group_webhook_operations WHERE organization_id=$1 AND id=$2',[org,previous.id])).rows[0];
          if(busy?.busy)throw new GroupCatalogError('GROUP_WEBHOOK_REFRESHING');}
        const uncertain=previous&&['DISPATCHED','UNKNOWN'].includes(previous.phase);
        if(uncertain&&previous.binding_fingerprint!==binding(org,channel,current))throw new GroupCatalogError('GROUP_WEBHOOK_UNKNOWN');
        let op:Operation;
        if(previous?.phase==='PREPARED'||uncertain){
          op=(await tx.query<Operation>(`UPDATE whatsapp_group_webhook_operations SET lease_token=$3,lease_expires_at=clock_timestamp()+interval '60 seconds',
            phase=CASE WHEN phase='DISPATCHED' THEN 'UNKNOWN' ELSE phase END,updated_at=clock_timestamp()
            WHERE organization_id=$1 AND id=$2 RETURNING *`,[org,previous.id,lease])).rows[0]!;
          if(!uncertain&&(op.binding_fingerprint!==binding(org,channel,current)||op.expected_identity_revision!==c.identity_revision||op.catalog_revision!==c.catalog_revision)){
            op=(await tx.query<Operation>(`UPDATE whatsapp_group_webhook_operations SET binding_fingerprint=$3,instance_id=$4,
              expected_identity_revision=$5,catalog_revision=$6,identity_revision=NULL,identity_fingerprint=NULL,safe_error=NULL,updated_at=clock_timestamp()
              WHERE organization_id=$1 AND id=$2 RETURNING *`,[org,op.id,binding(org,channel,current),current.instance_id,c.identity_revision,c.catalog_revision])).rows[0]!;
          }
        }else op=(await tx.query<Operation>(`INSERT INTO whatsapp_group_webhook_operations(organization_id,channel_id,instance_id,actor_id,binding_fingerprint,
          expected_identity_revision,catalog_revision,phase,lease_token,lease_expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,'PREPARED',$8,clock_timestamp()+interval '60 seconds') RETURNING *`,
          [org,channel,current.instance_id,p.actorId,binding(org,channel,current),c.identity_revision,c.catalog_revision,lease])).rows[0]!;
        return {current,c,op,uncertain:Boolean(uncertain)};
      });
      let dispatched=captured.uncertain;
      const context:ProviderContext={organizationId:org,requestId:lease,deadline:new Date(Date.now()+45000),signal:AbortSignal.timeout(45000)};
      const checkpoint=async(phase:'DISPATCHED'|'CONFIRMED',fingerprint:string,revision:number)=>options.transact(org,async tx=>{
        const current=await access(tx,p,channel,true),c=await catalog(tx,org,channel);
        if(!current.connected||binding(org,channel,current)!==captured.op.binding_fingerprint)throw new GroupCatalogError('GROUP_IDENTITY_CHANGED');
        if(!c||c.identity_revision!==captured.c.identity_revision||c.catalog_revision!==captured.c.catalog_revision)throw new GroupCatalogError('GROUP_REFRESH_LEASE_LOST');
        const updated=await tx.query(`UPDATE whatsapp_group_webhook_operations SET phase=$5,identity_fingerprint=$6,identity_revision=$7,
          dispatched_at=CASE WHEN $5='DISPATCHED' THEN clock_timestamp() ELSE dispatched_at END,
          observed_at=CASE WHEN $5='CONFIRMED' THEN clock_timestamp() ELSE observed_at END,safe_error=NULL,
          lease_token=CASE WHEN $5='CONFIRMED' THEN NULL ELSE lease_token END,lease_expires_at=CASE WHEN $5='CONFIRMED' THEN NULL ELSE lease_expires_at END,
          updated_at=clock_timestamp() WHERE organization_id=$1 AND channel_id=$2 AND id=$3 AND lease_token=$4 AND lease_expires_at>clock_timestamp()
          AND (CASE WHEN $5='DISPATCHED' THEN phase='PREPARED' ELSE phase IN ('PREPARED','DISPATCHED','UNKNOWN') END) RETURNING id`,
          [org,channel,captured.op.id,lease,phase,fingerprint,revision]);
        if(!updated.rowCount)throw new GroupCatalogError('GROUP_REFRESH_LEASE_LOST');
      });
      try{
        const before=await options.readIdentity(context,captured.current.upstream_instance_key);
        if(!before.connected||!before.phone||!/^([1-9]\d{6,14})$/u.test(before.phone))throw new GroupCatalogError('GROUP_IDENTITY_CHANGED');
        const fingerprint=identity(org,channel,before.phone),revision=Number(captured.c.identity_revision)
          +(captured.c.identity_fingerprint&&captured.c.identity_fingerprint!==fingerprint?1:0);
        if(captured.uncertain&&captured.op.identity_fingerprint!==fingerprint)throw new GroupCatalogError('GROUP_IDENTITY_CHANGED');
        let configuration:Awaited<ReturnType<GroupWebhookOptions['readConfiguration']>>;
        try{configuration=await options.readConfiguration(context,captured.current.upstream_instance_key,org,channel);}
        catch{throw new GroupCatalogError(dispatched?'GROUP_WEBHOOK_UNKNOWN':'GROUP_WEBHOOK_UNAVAILABLE',502);}
        if(configuration!=='MATCHING'){
          if(dispatched)throw new GroupCatalogError('GROUP_WEBHOOK_UNKNOWN');
          await checkpoint('DISPATCHED',fingerprint,revision);dispatched=true;
          // Commit-before-I/O ensures a lost ACK/restart can never repeat POST.
          try{await options.setConfiguration(context,captured.current.upstream_instance_key,org,channel);}catch{/* GET is the only confirmation. */}
          try{configuration=await options.readConfiguration(context,captured.current.upstream_instance_key,org,channel);}
          catch{throw new GroupCatalogError('GROUP_WEBHOOK_UNKNOWN',502);}
          if(configuration!=='MATCHING')throw new GroupCatalogError('GROUP_WEBHOOK_UNKNOWN');
        }
        const after=await options.readIdentity(context,captured.current.upstream_instance_key);
        if(!after.connected||after.phone!==before.phone)throw new GroupCatalogError('GROUP_IDENTITY_CHANGED');
        await checkpoint('CONFIRMED',fingerprint,revision);
      }catch(error){
        const code=(error as {code?:unknown})?.code;
        const safe=code==='GROUP_IDENTITY_CHANGED'?'IDENTITY_CHANGED':code==='GROUP_ACCESS_DENIED'||error instanceof TenantOperationalError?'ACCESS_DENIED'
          :code==='GROUP_REFRESH_LEASE_LOST'?'LEASE_LOST':dispatched?'CONFIGURATION_UNKNOWN':'CONFIGURATION_UNAVAILABLE';
        await cleanup(org,channel,captured.op.id,lease,safe);
        if(error instanceof GroupCatalogError||error instanceof TenantOperationalError)throw error;
        throw new GroupCatalogError(dispatched?'GROUP_WEBHOOK_UNKNOWN':'GROUP_WEBHOOK_UNAVAILABLE',502);
      }
    },
  };
}
