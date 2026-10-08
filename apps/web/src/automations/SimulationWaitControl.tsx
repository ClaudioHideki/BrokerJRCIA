export type SimulatedEvent={type:'MESSAGE';text:string}|{type:'ELAPSE';seconds:number};

export function SimulationWaitControl({wakeAt,clock,events,disabled,onAdvance}:{wakeAt:string|undefined;clock:string;events:SimulatedEvent[];disabled:boolean;onAdvance:(seconds:number)=>void}){
  const elapsed=events.reduce((total,event)=>total+(event.type==='ELAPSE'?event.seconds:0),0);
  const seconds=wakeAt?Math.max(1,Math.ceil((Date.parse(wakeAt)-Date.parse(clock))/1000)-elapsed):NaN;
  const valid=Number.isSafeInteger(seconds)&&seconds>=1&&seconds<=604800;
  return <div><p>Espera simulada: avançar o relógio não envia mensagens nem agenda uma execução real.</p>
    <button type="button" disabled={disabled||!valid||events.length>=30} onClick={()=>onAdvance(seconds)}>Avançar até o fim da espera</button>
    {!valid&&<p>Não foi possível identificar o prazo desta espera. Reinicie a simulação para atualizar o estado.</p>}
  </div>;
}
