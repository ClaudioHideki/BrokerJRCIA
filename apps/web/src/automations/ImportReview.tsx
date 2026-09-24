export interface ImportReport {
  summary:{total:number;exact:number;partial:number;unsupported:number;manualReviewRequired:boolean};
  nodes:Array<{sourceId:string;sourceType:string;classification:string;targetType:string|null;notes:string[]}>;
  warnings:string[];
}

export function ImportReview({report}:{report:ImportReport}) {
  return <section className="flows-alert" aria-label="Compatibilidade da importação">
    <h2>Revisar importação</h2>
    <p>{report.summary.total} blocos: {report.summary.exact} compatíveis, {report.summary.partial} para revisar e {report.summary.unsupported} para substituir.</p>
    <p>O arquivo será salvo como rascunho. Credenciais e vínculos de caixas devem ser configurados nesta empresa.</p>
    {report.summary.manualReviewRequired&&<p>A publicação exige adaptar os blocos e validar todas as conexões. Importar não ativa envios.</p>}
    {report.nodes.some(node=>node.classification!=='EXACT')&&<details><summary>Blocos que precisam de revisão</summary><ol>
      {report.nodes.map((node,index)=>node.classification==='EXACT'?null:<li key={`${node.sourceId}-${index}`}>Bloco {index+1} ({node.sourceId}): {node.classification==='UNSUPPORTED'?'substitua por um bloco JRC equivalente':'revise os campos, as saídas e as credenciais'}. {node.notes.join(' ')}</li>)}
    </ol></details>}
  </section>;
}
