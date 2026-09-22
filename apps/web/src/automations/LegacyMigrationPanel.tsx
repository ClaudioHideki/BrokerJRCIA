import { useCallback, useEffect, useState } from 'react';

import type { ApiClient } from '../api/client.js';

type MigrationStatus='CONVERTED'|'WAITING_FOR_DRAIN'|'MANAGED'|'LEGACY'|'CONFLICT'|'ROLLED_BACK';
interface MigrationItem {source:string;sourceId:string;automationId:string|null;sourceVersion:number|null;sourceChecksum:string|null;targetChecksum:string|null;status:MigrationStatus;bindingCount:number;liveExecutionCount:number;report:Record<string,unknown>;updatedAt:string}
interface MigrationView {data:MigrationItem[];metrics:{legacyFlows:number;legacyExecutions:number;legacyBindings:number;conversionFailures:number}}
const canWrite=(role:string)=>['OWNER','ADMIN'].includes(role);
const short=(checksum:string|null)=>checksum?`${checksum.slice(0,12)}…`:'—';

export function LegacyMigrationPanel({client,role}:{client:ApiClient;role:string}){
 const [view,setView]=useState<MigrationView|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const load=useCallback(()=>client.request<MigrationView>('/v1/automations/migrations/legacy').then(setView),[client]);
 useEffect(()=>{void load().catch(()=>setError('Não foi possível consultar a migração legada.'));},[load]);
 async function mutate(path:string,body:Record<string,unknown>,message:string){setBusy(true);setError('');setNotice('');try{await client.request(path,{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(body)});await load();setNotice(message);}catch{setError('A operação não foi concluída. Consulte o relatório e tente novamente.');}finally{setBusy(false);}}
 const writable=canWrite(role);
 return <section className="legacy-migration" aria-labelledby="legacy-migration-title"><header><div><span>MIGRAÇÃO CONTROLADA</span><h2 id="legacy-migration-title">Flows legados</h2><p>Converta e assuma canais somente depois que execuções vivas terminarem.</p></div>{writable&&<button className="flows-primary" disabled={busy} onClick={()=>void mutate('/v1/automations/migrations/legacy',{limit:200},'Lote processado. Revise os estados antes do cutover.')}>Migrar próximo lote</button>}</header>
 {error&&<p role="alert" className="flows-alert flows-alert--error">{error}</p>}{notice&&<p role="status" className="flows-alert">{notice}</p>}
 {!view?<p>Consultando migração…</p>:<><div className="legacy-migration-metrics"><strong>{view.metrics.legacyFlows} fluxos legados</strong><span>{view.metrics.legacyExecutions} execuções históricas</span><span>{view.metrics.legacyBindings} canais vinculados</span><span>{view.metrics.conversionFailures} incompatíveis</span></div>
 <div className="legacy-migration-list">{view.data.map(item=><article key={`${item.source}:${item.sourceId}`}><div className="legacy-migration-summary"><span className={`execution-state execution-state--${item.status.toLowerCase()}`}>{item.status}</span><strong>{item.sourceId}</strong><span>v{item.sourceVersion??'—'} · {item.bindingCount} vínculos</span>{item.liveExecutionCount>0&&<span className="flows-alert flows-alert--error">{item.liveExecutionCount} execuções vivas</span>}</div><dl><div><dt>Checksum origem</dt><dd><code title={item.sourceChecksum??''}>{short(item.sourceChecksum)}</code></dd></div><div><dt>Checksum destino</dt><dd><code title={item.targetChecksum??''}>{short(item.targetChecksum)}</code></dd></div><div><dt>Atualizado</dt><dd>{new Date(item.updatedAt).toLocaleString('pt-BR')}</dd></div></dl>
 {Array.isArray(item.report.errors)&&item.report.errors.length>0&&<div className="flows-alert flows-alert--error"><strong>Conversão manual necessária</strong><ul>{item.report.errors.map(value=><li key={String(value)}>{String(value)}</li>)}</ul></div>}
 {writable&&<div className="flows-actions">{['CONVERTED','WAITING_FOR_DRAIN'].includes(item.status)&&<button disabled={busy||item.liveExecutionCount>0} onClick={()=>{if(window.confirm(`Concluir a migração de ${item.sourceId}? O canal passará ao Automation Runtime v2.`))void mutate(`/v1/automations/migrations/legacy/${item.sourceId}/cutover`,{},'Cutover verificado.');}}>Concluir migração</button>}{item.status==='MANAGED'&&<button disabled={busy} onClick={()=>{if(window.confirm(`Reverter ${item.sourceId} para o fluxo legado? A operação será recusada se houver execução viva.`))void mutate(`/v1/automations/migrations/legacy/${item.sourceId}/rollback`,{},'Rollback concluído.');}}>Reverter para fluxo legado</button>}</div>}</article>)}</div></>}
 </section>;
}
