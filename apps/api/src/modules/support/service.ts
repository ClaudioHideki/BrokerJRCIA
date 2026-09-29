import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { CreateSupportTicketSchema, ReplySupportTicketSchema, UpdateSupportTicketSchema, type SupportTicket, type SupportMessage, type SupportTicketDetail, type SupportTicketList } from '@jrc/contracts';
import type { OrganizationTransaction, TenantTransaction } from '../../db/tenant-transaction.js';

export type SupportActor = { kind: 'TENANT'; organizationId: string; actorId: string; canWrite: boolean } | { kind: 'PLATFORM'; actorId: string };
export class SupportError extends Error { constructor(readonly code: string, readonly statusCode = 400) { super(code); } }
export function assertSupportWrite(actor: SupportActor): void { if (actor.kind === 'TENANT' && !actor.canWrite) throw new SupportError('SUPPORT_FORBIDDEN', 403); }
export const supportStatusAfterReply = (kind: SupportActor['kind']) => kind === 'TENANT' ? 'OPEN' as const : 'WAITING_CUSTOMER' as const;
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tenant = (actor: SupportActor) => actor.kind === 'TENANT' ? actor.organizationId : null;
const columns = `t.id,t.organization_id AS "organizationId",o.name AS "organizationName",t.title,t.status,t.revision,t.assignee_id AS "assigneeId",
 t.created_at AS "createdAt",t.updated_at AS "updatedAt",t.first_response_at AS "firstResponseAt",t.response_due_at AS "responseDueAt",t.resolved_at AS "resolvedAt"`;
const ticketView = (row: SupportTicket): SupportTicket => ({ ...row, createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString(),
  responseDueAt: new Date(row.responseDueAt).toISOString(), firstResponseAt: row.firstResponseAt ? new Date(row.firstResponseAt).toISOString() : null, resolvedAt: row.resolvedAt ? new Date(row.resolvedAt).toISOString() : null });

export async function withSupportPlatformTransaction<T>(pool: Pool, work: OrganizationTransaction<T>): Promise<T> {
  const client = await pool.connect();
  let transactionOpen = false;
  let releaseError: Error | undefined;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const identity = await client.query('select current_user,session_user,rolsuper,rolbypassrls from pg_roles where rolname=current_user');
    const row = identity.rows[0];
    if (row?.current_user !== 'jrc_platform' || row.session_user !== 'jrc_platform' || row.rolsuper || row.rolbypassrls) throw new Error('SUPPORT_PLATFORM_CONNECTION_REQUIRED');
    const result = await work(client as unknown as TenantTransaction);
    await client.query('COMMIT'); transactionOpen = false; return result;
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        throw new AggregateError([error, rollbackError], 'Support transaction rollback failed');
      }
    }
    throw error;
  } finally { client.release(releaseError); }
}

export function createSupportService(options: {
  transact<T>(org: string, work: OrganizationTransaction<T>): Promise<T>;
  staffTransact?<T>(work: OrganizationTransaction<T>): Promise<T>;
  responseHours?: number;
}) {
  const hours = options.responseHours ?? 24;
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) throw new Error('SUPPORT_RESPONSE_HOURS_INVALID');
  const transaction = <T>(actor: SupportActor, work: OrganizationTransaction<T>) => {
    if (actor.kind === 'TENANT') return options.transact(actor.organizationId, work);
    if (!options.staffTransact) throw new SupportError('SUPPORT_UNAVAILABLE', 503);
    return options.staffTransact(work);
  };
  const get = async (tx: TenantTransaction, actor: SupportActor, id: string, lock = false) => {
    const result = await tx.query<SupportTicket>(`SELECT ${columns} FROM support_tickets t JOIN organizations o ON o.id=t.organization_id
      WHERE t.id=$1 AND ($2::uuid IS NULL OR t.organization_id=$2) ${lock ? 'FOR UPDATE OF t' : ''}`, [id, tenant(actor)]);
    if (!result.rows[0]) throw new SupportError('SUPPORT_NOT_FOUND', 404);
    return ticketView(result.rows[0]);
  };
  const detail = async (tx: TenantTransaction, actor: SupportActor, id: string, before?: string): Promise<SupportTicketDetail> => {
    const ticket = await get(tx, actor, id);
    const rows = await tx.query<SupportMessage>(`SELECT id,author_kind AS "authorKind",kind,body,created_at AS "createdAt" FROM support_messages
      WHERE organization_id=$1 AND ticket_id=$2 AND ($3::uuid IS NULL OR (created_at,id) <
        (SELECT created_at,id FROM support_messages WHERE organization_id=$1 AND ticket_id=$2 AND id=$3))
      ORDER BY created_at DESC,id DESC LIMIT 101`, [ticket.organizationId, id, before ?? null]);
    return { ticket, messages: rows.rows.slice(0,100).reverse().map(row => ({ ...row, createdAt: new Date(row.createdAt).toISOString() })), olderMessagesAvailable: rows.rows.length > 100 };
  };
  const organizationWritable = async (tx: TenantTransaction, organizationId: string) => {
    const result = await tx.query("SELECT id FROM organizations WHERE id=$1 AND status<>'DISABLED'", [organizationId]);
    if (!result.rows.length) throw new SupportError('SUPPORT_ORGANIZATION_DISABLED', 409);
  };
  const append = (tx: TenantTransaction, actor: SupportActor, organizationId: string, id: string, message: string, requestId: string, hash: string, kind = 'REPLY') =>
    tx.query(`INSERT INTO support_messages(organization_id,ticket_id,actor_id,author_kind,body,request_id,request_hash,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [organizationId,id,actor.actorId,actor.kind,message,requestId,hash,kind]);
  return {
    async list(actor: SupportActor, cursor?: string): Promise<SupportTicketList> {
      return transaction(actor, async tx => {
        const result = await tx.query<SupportTicket>(`SELECT ${columns} FROM support_tickets t JOIN organizations o ON o.id=t.organization_id
          WHERE ($1::uuid IS NULL OR t.organization_id=$1) AND ($2::uuid IS NULL OR (t.updated_at,t.id)<
            (SELECT updated_at,id FROM support_tickets WHERE id=$2 AND ($1::uuid IS NULL OR organization_id=$1)))
          ORDER BY t.updated_at DESC,t.id DESC LIMIT 51`, [tenant(actor),cursor ?? null]);
        const data = result.rows.slice(0,50).map(ticketView); return { data, ...(result.rows.length>50 ? {nextCursor:data.at(-1)!.id} : {}) };
      });
    },
    read: (actor: SupportActor, id: string, before?: string) => transaction(actor, tx => detail(tx, actor, id, before)),
    async create(actor: SupportActor, value: unknown): Promise<SupportTicketDetail> {
      assertSupportWrite(actor); if (actor.kind !== 'TENANT') throw new SupportError('SUPPORT_TENANT_REQUIRED',403);
      const input = CreateSupportTicketSchema.parse(value), hash = fingerprint([actor.actorId,input.title,input.message]);
      return transaction(actor, async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`support-create:${actor.organizationId}`]);
        await organizationWritable(tx, actor.organizationId);
        const previous = await tx.query<{id:string;request_hash:string}>('SELECT id,request_hash FROM support_tickets WHERE organization_id=$1 AND request_id=$2', [actor.organizationId,input.requestId]);
        if (previous.rows[0]) { if (previous.rows[0].request_hash!==hash) throw new SupportError('SUPPORT_IDEMPOTENCY_CONFLICT',409); return detail(tx,actor,previous.rows[0].id); }
        const count = await tx.query<{count:string}>("SELECT count(*)::text FROM support_tickets WHERE organization_id=$1 AND created_at>now()-interval '1 day'",[actor.organizationId]);
        if (Number(count.rows[0]?.count)>=50) throw new SupportError('SUPPORT_DAILY_LIMIT',429);
        const id = randomUUID();
        await tx.query(`INSERT INTO support_tickets(id,organization_id,title,request_id,request_hash,response_due_at) VALUES($1,$2,$3,$4,$5,now()+$6*interval '1 hour')`,[id,actor.organizationId,input.title,input.requestId,hash,hours]);
        await append(tx,actor,actor.organizationId,id,input.message,input.requestId,hash); return detail(tx,actor,id);
      });
    },
    async reply(actor: SupportActor, id: string, value: unknown): Promise<SupportTicketDetail> {
      assertSupportWrite(actor); const input = ReplySupportTicketSchema.parse(value), hash = fingerprint([actor.kind,actor.actorId,input.message]);
      return transaction(actor,async tx => {
        const ticket = await get(tx,actor,id,true); await organizationWritable(tx,ticket.organizationId);
        const existing = await tx.query<{request_hash:string}>('SELECT request_hash FROM support_messages WHERE organization_id=$1 AND ticket_id=$2 AND request_id=$3',[ticket.organizationId,id,input.requestId]);
        if (existing.rows[0]) { if(existing.rows[0].request_hash!==hash) throw new SupportError('SUPPORT_IDEMPOTENCY_CONFLICT',409); return detail(tx,actor,id); }
        if(ticket.revision!==input.revision) throw new SupportError('SUPPORT_CHANGED',409);
        await append(tx,actor,ticket.organizationId,id,input.message,input.requestId,hash);
        await tx.query(`UPDATE support_tickets SET status=$3,revision=revision+1,updated_at=now(),resolved_at=null,
          first_response_at=CASE WHEN $4 THEN COALESCE(first_response_at,now()) ELSE first_response_at END WHERE organization_id=$1 AND id=$2`,[ticket.organizationId,id,supportStatusAfterReply(actor.kind),actor.kind==='PLATFORM']);
        return detail(tx,actor,id);
      });
    },
    async update(actor: SupportActor, id: string, value: unknown): Promise<SupportTicketDetail> {
      assertSupportWrite(actor); const input = UpdateSupportTicketSchema.parse(value);
      if(actor.kind!=='PLATFORM' && (input.status!=='RESOLVED'||input.assignToMe!==undefined)) throw new SupportError('SUPPORT_FORBIDDEN',403);
      return transaction(actor,async tx => {
        const ticket = await get(tx,actor,id,true); await organizationWritable(tx,ticket.organizationId);
        if(ticket.revision!==input.revision) throw new SupportError('SUPPORT_CHANGED',409);
        await tx.query(`UPDATE support_tickets SET status=$3,revision=revision+1,updated_at=now(),
          assignee_id=CASE WHEN $4 THEN $5::uuid ELSE assignee_id END,resolved_at=CASE WHEN $3='RESOLVED' THEN now() ELSE NULL END WHERE organization_id=$1 AND id=$2`,[ticket.organizationId,id,input.status,input.assignToMe===true,actor.actorId]);
        await append(tx,actor,ticket.organizationId,id,`Status: ${input.status}${input.assignToMe ? ' · atendimento assumido' : ''}`,randomUUID(),fingerprint(input),'EVENT');
        return detail(tx,actor,id);
      });
    },
  };
}
export type SupportService = ReturnType<typeof createSupportService>;
