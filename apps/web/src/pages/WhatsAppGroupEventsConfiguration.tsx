import {useEffect,useRef,useState} from 'react';
import {WhatsAppGroupEventsConfigurationSchema,type WhatsAppGroupEventsConfiguration as Configuration} from '@jrc/contracts';
import {ApiClientError,type ApiClient} from '../api/client.js';
export function WhatsAppGroupEventsConfiguration({client,channelId,organizationId,revision}:{client:ApiClient;channelId:string;organizationId:string;revision:number}){
  const generation=useRef(0),[view,setView]=useState<{client:ApiClient;channel:string;org:string;data:Configuration|null;error:boolean}>
    ({client,channel:channelId,org:organizationId,data:null,error:false});
  useEffect(()=>{
    const current=++generation.current,controller=new AbortController();
    const clear=()=>{generation.current++;controller.abort();setView({client,channel:channelId,org:organizationId,data:null,error:false});};
    setView({client,channel:channelId,org:organizationId,data:null,error:false});
    const unregister=client.registerTenantPurge(clear);
    void client.request<unknown>(`/v1/channels/${encodeURIComponent(channelId)}/whatsapp-group-events-configuration`,{signal:controller.signal})
      .then(value=>{
        const data=WhatsAppGroupEventsConfigurationSchema.parse(value);
        if(data.organizationId!==organizationId||data.channelId!==channelId)throw new Error('INVALID_CONFIGURATION_SCOPE');
        if(current===generation.current&&!controller.signal.aborted)setView({client,channel:channelId,org:organizationId,data,error:false});
      }).catch(error=>{
        if(current!==generation.current||controller.signal.aborted)return;
        const forbidden=error instanceof ApiClientError&&[401,403].includes(error.status);
        setView({client,channel:channelId,org:organizationId,data:null,error:!forbidden});
      });
    return()=>{generation.current++;controller.abort();unregister();};
  },[client,channelId,organizationId,revision]);
  if(view.client!==client||view.channel!==channelId||view.org!==organizationId)return null;
  if(view.error)return <p>Não foi possível conferir a configuração dos eventos de grupos.</p>;
  const data=view.data;if(!data)return null;
  const text=data.status==='UNKNOWN'?'A configuração dos eventos aguarda confirmação. Atualizar grupos fará somente a conferência desta configuração.'
    :data.status==='CONFIRMED'?'Recebimento de eventos de grupos configurado.'
    :data.status==='STALE'?'A conexão mudou. Atualize os grupos para conferir a configuração dos eventos.'
    :'Atualizar grupos do WhatsApp também prepara o recebimento dos eventos nesta conexão.';
  return <div aria-label="Configuração dos eventos de grupos"><p role="status">{text}</p>
    {data.observedAt?<p>Configuração conferida em <time dateTime={data.observedAt}>{new Date(data.observedAt).toLocaleString('pt-BR')}</time>.</p>:null}
  </div>;
}
