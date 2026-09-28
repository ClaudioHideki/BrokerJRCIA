export interface ImportReport {
  summary:{total:number;exact:number;partial:number;unsupported:number;manualReviewRequired:boolean};
  nodes:Array<{sourceId:string;sourceType:string;classification:string;targetType:string|null;notes:string[]}>;
  warnings:string[];
}

type ReviewNode=ImportReport['nodes'][number]&{originalIndex:number};
type ReviewGroup={sourceType:string;classification:string;nodes:ReviewNode[]};

function groupReviewNodes(nodes:ImportReport['nodes']):ReviewGroup[] {
  const groups=new Map<string,ReviewGroup>();
  nodes.forEach((node,originalIndex)=>{
    if(node.classification==='EXACT')return;
    const sourceType=node.sourceType||'Tipo não informado';
    const key=`${node.classification}:${sourceType}`;
    let group=groups.get(key);
    if(!group){group={sourceType,classification:node.classification,nodes:[]};groups.set(key,group);}
    group.nodes.push({...node,originalIndex});
  });
  return [...groups.values()].sort((a,b)=>b.nodes.length-a.nodes.length||a.sourceType.localeCompare(b.sourceType));
}

export function ImportReview({report}:{report:ImportReport}) {
  const reviewGroups=groupReviewNodes(report.nodes);
  return <section className="flows-alert" aria-label="Compatibilidade da importação">
    <h2>Revisar importação</h2>
    <p>{report.summary.total} blocos: {report.summary.exact} compatíveis, {report.summary.partial} para revisar e {report.summary.unsupported} para substituir.</p>
    <p>O arquivo será salvo como rascunho. Credenciais e vínculos de caixas devem ser configurados nesta empresa.</p>
    {report.summary.manualReviewRequired&&<p>A publicação exige adaptar os blocos e validar todas as conexões. Importar não ativa envios.</p>}
    {reviewGroups.length>0&&<details><summary>Blocos que precisam de revisão ({reviewGroups.length} tipos)</summary><ul>
      {reviewGroups.map(group=><li key={`${group.classification}:${group.sourceType}`}><details>
        <summary>{group.sourceType}: {group.nodes.length} {group.classification==='UNSUPPORTED'?'para substituir':'para revisar'}</summary>
        <p>{group.classification==='UNSUPPORTED'?'Substitua por blocos JRC equivalentes e reconstrua suas conexões.':'Revise os campos, as saídas e as credenciais antes de publicar.'}</p>
        <ol>{group.nodes.map(node=><li key={`${node.sourceId}-${node.originalIndex}`}>
          Bloco {node.originalIndex+1} ({node.sourceId}): {node.notes.join(' ')}
        </li>)}</ol>
      </details></li>)}
    </ul></details>}
  </section>;
}
