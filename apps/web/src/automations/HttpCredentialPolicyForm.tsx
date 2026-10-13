import {useState} from 'react';
import {HttpCredentialPolicySchema} from '@jrc/contracts';
export function HttpCredentialPolicyForm({name,allowedOrigins,disabled,onSave}:{name:string;allowedOrigins:string[];disabled:boolean;onSave:(origins:string[])=>void}){
 const [text,setText]=useState(allowedOrigins.join('\n'));
 const parsed=HttpCredentialPolicySchema.safeParse({allowedOrigins:text.split(/\r?\n/u).map(value=>value.trim()).filter(Boolean)});
 return <form onSubmit={event=>{event.preventDefault();if(!disabled&&parsed.success)onSave(parsed.data.allowedOrigins);}}><label>Destinos HTTPS permitidos para {name}<textarea disabled={disabled} value={text} onChange={event=>setText(event.target.value)} placeholder="https://api.empresa.com"/></label><p>Um origin por linha, sem caminho ou token. Salvar altera a revisão; atualize a credencial por nome nos blocos de consulta antes de publicar.</p>{!parsed.success&&<p role="alert">Informe de 1 a 20 destinos HTTPS públicos, sem caminhos ou credenciais.</p>}<button disabled={disabled||!parsed.success}>Salvar destinos permitidos</button></form>;
}
