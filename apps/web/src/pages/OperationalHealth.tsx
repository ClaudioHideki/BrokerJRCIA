import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useApiClient } from '../auth/SessionProvider.js';
import { PageHeading } from '../broker/components.js';

type State='UP'|'DEGRADED'|'DOWN'|'UNKNOWN';
interface Component {key:string;label:string;state:State;code:string;observedAt:string|null;metric?:number;unit?:string}
interface Health {observedAt:string;overall:State;components:Component[];alerts:Array<{code:string;component:string;state:State}>}
const label:Record<State,string>={UP:'Operacional',DEGRADED:'Degradado',DOWN:'Indisponível',UNKNOWN:'Não observado'};
export function OperationalHealthPage(){const client=useApiClient(),[data,setData]=useState<Health|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
 const load=useCallback(async()=>{setLoading(true);setError('');try{setData(await client.request<Health>('/v1/operations/health'));}catch{setError('Não foi possível consultar a saúde operacional.');}finally{setLoading(false);}},[client]);
 useEffect(()=>{void load();const timer=setInterval(()=>void load(),30_000);return()=>clearInterval(timer);},[load]);
 return <section><PageHeading title="Health Center" description="Estado atual de cada camada da plataforma."><button className="button button--secondary" onClick={()=>void load()} disabled={loading}>Atualizar</button></PageHeading>
  {error?<p role="alert" className="flows-alert flows-alert--error">{error}</p>:null}
  {data?<><div className={`health-overall health-state--${data.overall.toLowerCase()}`}><strong>{label[data.overall]}</strong><span>Observado em {new Date(data.observedAt).toLocaleString('pt-BR')}</span></div>
   <div className="health-component-grid">{data.components.map(item=><article key={item.key}><header><h2>{item.label}</h2><span className={`health-state health-state--${item.state.toLowerCase()}`}>{label[item.state]}</span></header>{item.metric!==undefined?<strong>{item.metric} <small>{item.unit}</small></strong>:null}<code>{item.code}</code>{item.observedAt?<p>{new Date(item.observedAt).toLocaleString('pt-BR')}</p>:<p>Sem heartbeat registrado</p>}</article>)}</div>
   <section className="panel"><div className="panel-heading"><h2>Alertas ativos</h2><span className="subtle-tag">{data.alerts.length}</span></div>{data.alerts.length?<table className="broker-table"><thead><tr><th>Componente</th><th>Estado</th><th>Código</th><th>Ação</th></tr></thead><tbody>{data.alerts.map(item=><tr key={`${item.component}:${item.code}`}><td>{item.component}</td><td>{label[item.state]}</td><td><code>{item.code}</code></td><td>{item.component==='UNKNOWN_EXECUTIONS'?<Link to="/automation-executions">Reconciliar →</Link>:'Verificar configuração e logs por correlação'}</td></tr>)}</tbody></table>:<p>Nenhum alerta operacional ativo.</p>}</section></>:loading?<p>Consultando componentes…</p>:null}
 </section>}
