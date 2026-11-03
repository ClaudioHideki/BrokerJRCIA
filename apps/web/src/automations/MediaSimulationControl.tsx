import type {AutomationMediaSimulationEvent} from '@jrc/contracts';
export function MediaSimulationControl({disabled,onInput}:{disabled:boolean;onInput:(event:AutomationMediaSimulationEvent)=>void}){
 return <fieldset disabled={disabled}><legend>Anexo de exemplo</legend>
  <p>Exemplos sintéticos: nenhum arquivo é enviado, baixado ou armazenado. A referência do teste não comprova custódia.</p>
  <button type="button" onClick={()=>onInput({type:'MEDIA',kind:'image',fileName:'exemplo.png'})}>Usar imagem de exemplo</button>
  <button type="button" onClick={()=>onInput({type:'MEDIA',kind:'document',fileName:'exemplo.pdf'})}>Usar arquivo de exemplo</button>
 </fieldset>;
}
