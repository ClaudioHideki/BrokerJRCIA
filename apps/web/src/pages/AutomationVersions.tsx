import {useEffect,useState} from 'react';
import {Link,useLocation,useParams} from 'react-router';
import type {AutomationPublishedVersionV1} from '@jrc/contracts';
import {useApiClient,useSession} from '../auth/SessionProvider.js';
import {channelSetupNavigation} from '../channels/setup-navigation.js';
import {getAutomation,listVersions} from '../automations/api.js';

export function AutomationVersionsPage(){
 const setup=channelSetupNavigation(useLocation().search),{id=''}=useParams(),client=useApiClient(),{session}=useSession();
 const organizationId=session?.activeOrganization.id,scope=organizationId+':'+id;
 const [result,setResult]=useState<{scope:string;name:string;versions:AutomationPublishedVersionV1[]}|null>(null);
 const [failure,setFailure]=useState<{scope:string;message:string}|null>(null);
 useEffect(()=>{
  let live=true;setResult(null);setFailure(null);
  if(organizationId)void Promise.all([getAutomation(client,id),listVersions(client,id)]).then(([item,versions])=>{
   if(!live)return;
   if(item.id!==id||item.organizationId!==organizationId||versions.some(version=>version.automationId!==id||version.organizationId!==organizationId)
     ||new Set(versions.map(version=>version.version)).size!==versions.length)throw Error('O histórico não corresponde à empresa e à automação selecionadas.');
   setResult({scope,name:item.name,versions:[...versions].sort((left,right)=>right.version-left.version)});
  }).catch(reason=>{if(live)setFailure({scope,message:reason instanceof Error?reason.message:'Não foi possível consultar o histórico.'});});
  return()=>{live=false;};
 },[client,id,organizationId,scope]);
 const current=result?.scope===scope?result:null,error=failure?.scope===scope?failure.message:'';
 return <section className="automation-page"><Link to={`/automations/${id}/edit${setup.suffix}`}>← Editor</Link>
  <h1>{current?'Versões · '+current.name:'Histórico de versões'}</h1>
  <p>Cada publicação preserva uma versão imutável. A versão usada por cada caixa depende do vínculo configurado; publicar não troca esse vínculo.</p>
  {error&&<p role="alert">{error}</p>}{!current&&!error&&<p role="status">Carregando versões…</p>}
  {current&&(current.versions.length?current.versions.map(version=><details key={version.version}>
   <summary>v{version.version} · {new Date(version.publishedAt).toLocaleString('pt-BR')} · {version.graph.nodes.length} blocos</summary>
   <p>Checksum: <code>{version.checksum}</code></p><p>Versão imutável preservada para execuções iniciadas nela.</p>
  </details>):<p>Nenhuma versão publicada.</p>)}
 </section>;
}
