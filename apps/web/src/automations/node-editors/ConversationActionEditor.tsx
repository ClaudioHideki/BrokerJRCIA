import { useEffect, useRef, useState } from 'react';
import type { ActionCatalogPage, AutomationMediaAsset, ConversationAttributeDefinition, FlowNode } from '@jrc/contracts';
import { ApiClientError } from '../../api/client.js';
import type { ConversationActionTransport } from '../conversation-api.js';
import {DomainCommandFields} from './DomainCommandFields.js';

type Props = { node: FlowNode; editable: boolean; transport: ConversationActionTransport; onChange(data: FlowNode['data']): void };
type Scoped<T> = { key: string; transport: ConversationActionTransport; value: T };
type Form = { name: string; type: ConversationAttributeDefinition['valueType']; options: string };
const emptyForm: Form = { name: '', type: 'string', options: '' };
const accept = 'image/png,image/jpeg,audio/mpeg,audio/aac,audio/ogg,audio/mp4,video/mp4,video/3gpp,application/pdf,text/plain';
const errorMessage = (error: unknown, fallback: string) => error instanceof ApiClientError ? error.message : fallback;

export function ConversationActionEditor({ node, editable, transport, onChange }: Props) {
  const channel = typeof node.data.channelId === 'string' ? node.data.channelId : '';
  const [revision, setRevision] = useState(0);
  const key = `${transport.organizationId}:${transport.rootAutomationId}:${node.id}:${node.type}:${channel}:${revision}`;
  const current = useRef({ key, transport }); current.current = { key, transport };
  const mutation = useRef<{ key: string; transport: ConversationActionTransport; controller: AbortController } | null>(null);
  const [channelState, setChannels] = useState<Scoped<Array<{ id: string; name: string }>> | null>(null);
  const [catalogState, setCatalog] = useState<Scoped<ActionCatalogPage> | null>(null);
  const [mediaState, setMedia] = useState<Scoped<AutomationMediaAsset[]> | null>(null);
  const [errorState, setError] = useState<Scoped<string> | null>(null), [noticeState, setNotice] = useState<Scoped<string> | null>(null);
  const [busyState, setBusy] = useState<Scoped<boolean> | null>(null), [formState, setForm] = useState<Scoped<Form> | null>(null);
  const active = <T,>(state: Scoped<T> | null): T | undefined => state?.key === key && state.transport === transport ? state.value : undefined;
  const channels = active(channelState), catalog = active(catalogState), files = active(mediaState) ?? [];
  const error = active(errorState), notice = active(noticeState), busy = active(busyState) ?? false, form = active(formState) ?? emptyForm;
  const operation = node.type as keyof ActionCatalogPage['capabilities'], capability = catalog?.capabilities[operation];
  const supported = capability?.state === 'SUPPORTED', available = channels?.some(item => item.id === channel) === true;
  const modern = node.type === 'media' ? node.data.mediaEffectVersion === 2 : node.data.conversationEffectVersion === 2;
  const resources = catalog?.data.filter(item => item.kind === (node.type === 'tag' ? 'LABEL' : 'ATTRIBUTE')) ?? [];
  const resource = resources.find(item => item.id === node.data.resourceId), definition = resource?.definition;
  const source = node.data.valueSource as { kind?: string; value?: string | number | boolean; variable?: string } | undefined;
  const change = (data: Record<string, unknown>) => { if (editable) onChange({ ...node.data, ...data }); };
  const setFormFields = (value: Partial<Form>) => setForm({ key, transport, value: { ...form, ...value } });
  const chooseResource = (chosen: ActionCatalogPage['data'][number]) => change({ resourceId: chosen.id, resourceRevision: chosen.revision,
    ...(chosen.definition ? { valueSource: { kind: 'LITERAL', value: chosen.definition.valueType === 'boolean' ? false
      : chosen.definition.valueType === 'number' ? 0 : chosen.definition.allowedValues[0] ?? '' } } : {}) });

  useEffect(() => {
    const controller = new AbortController();
    void transport.listChannels(controller.signal).then(value => {
      if (!controller.signal.aborted) setChannels({ key, transport, value });
    }).catch(reason => {
      if (!controller.signal.aborted) setError({ key, transport, value: errorMessage(reason, 'Não foi possível consultar as caixas deste fluxo.') });
    });
    return () => {
      controller.abort();
      if (mutation.current?.key === key && mutation.current.transport === transport) {
        mutation.current.controller.abort(); mutation.current = null;
      }
    };
  }, [transport, key]);
  useEffect(() => {
    if (!channel || !available) return;
    const controller = new AbortController();
    void (async () => {
      const value = await transport.actionCatalog(channel, controller.signal);
      if (controller.signal.aborted) return;
      setCatalog({ key, transport, value });
      if (node.type === 'media' && value.capabilities.media.state === 'SUPPORTED') {
        const media = await transport.mediaCatalog(channel, controller.signal);
        if (!controller.signal.aborted) setMedia({ key, transport, value: media });
      }
    })().catch(reason => {
      if (!controller.signal.aborted) setError({ key, transport, value: errorMessage(reason, 'Não foi possível consultar o catálogo da caixa.') });
    });
    return () => controller.abort();
  }, [transport, key, channel, available, node.type]);

  function configure(selected: string) {
    if (!editable || !channels?.some(item => item.id === selected)) return;
    onChange(node.type === 'media'
      ? { mediaEffectVersion: 2, channelId: selected, mediaId: '', mediaRevision: 1, target: 'media.result', caption: '', timeoutMs: 15000 }
      : { conversationEffectVersion: 2, operation: node.type, channelId: selected, target: 'action.result', timeoutMs: 15000,
        ...(node.type==='domain'?{command:'create_lead'}:node.type === 'note' ? { text: typeof node.data.text === 'string' ? node.data.text : '' }
          : node.type === 'resolve' ? { status: 'RESOLVED' }
            : { resourceId: '', resourceRevision: '', ...(node.type === 'attribute' ? { valueSource: { kind: 'LITERAL', value: '' } } : {}) }) });
  }
  async function mutate(work: (signal: AbortSignal, live: () => boolean) => Promise<void>) {
    if (!editable || !supported || mutation.current?.key === key && mutation.current.transport === transport) return;
    const controller = new AbortController(), pending = { key, transport, controller };
    mutation.current = pending; setBusy({ key, transport, value: true }); setError(null); setNotice(null);
    const live = () => !controller.signal.aborted && current.current.key === key && current.current.transport === transport;
    try { await work(controller.signal, live); }
    catch (reason) { if (live()) setError({ key, transport, value: errorMessage(reason, 'Não foi possível concluir. Atualize o catálogo antes de tentar novamente.') }); }
    finally {
      if (mutation.current === pending) mutation.current = null;
      if (live()) setBusy({ key, transport, value: false });
    }
  }
  async function createResource() {
    if (!form.name.trim() || catalog?.profile !== 'STANDALONE' || !['tag', 'attribute'].includes(node.type)) return;
    await mutate(async (signal, live) => {
      const kind = node.type === 'tag' ? 'LABEL' : 'ATTRIBUTE';
      await transport.saveResource(channel, { name: form.name.trim(), key: 'resource_' + crypto.randomUUID().replaceAll('-', ''), kind,
        definition: kind === 'LABEL' ? null : { valueType: form.type, maxLength: 4096,
          allowedValues: form.type === 'enum' ? form.options.split('\n').map(value => value.trim()).filter(Boolean) : [] }, status: 'ACTIVE' }, signal);
      if (live()) { setForm({ key, transport, value: emptyForm }); setRevision(value => value + 1); }
    });
  }
  async function upload(file: File) {
    await mutate(async (signal, live) => {
      const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('video/') ? 'video' : 'document';
      const result = await transport.uploadMedia(channel, file, kind, signal);
      if (!live()) return;
      if (result.status === 'READY') { change({ mediaId: result.id, mediaRevision: result.revision }); setRevision(value => value + 1); }
      else setNotice({ key, transport, value: 'Arquivo recebido; aguardando confirmação do armazenamento. Atualize o catálogo antes de selecioná-lo.' });
    });
  }
  const literal = (value: string | number | boolean) => change({ valueSource: { kind: 'LITERAL', value } });
  const selectedFile = files.find(file => file.id === node.data.mediaId);
  const defaultLiteral = definition?.valueType === 'boolean' ? false : definition?.valueType === 'number' ? 0 : definition?.allowedValues[0] ?? '';
  return <div className="automation-action-editor">
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <fieldset disabled={!editable || busy}>
      {!modern && <p role="alert">Bloco histórico. Escolha uma caixa e reconfigure pelo catálogo atual antes de publicar.</p>}
      <label>Caixa da ação<select value={channel} onChange={event => configure(event.target.value)}>
        <option value="">Selecione uma caixa</option>
        {channel && !available && <option value={channel}>Caixa salva indisponível</option>}
        {channels?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      {!modern && available && <button type="button" onClick={() => configure(channel)}>Reconfigurar bloco</button>}
      {!channels && !error && <p role="status">Consultando caixas autorizadas…</p>}
      {channel && available && !catalog && !error && <p role="status">Consultando capacidades da caixa…</p>}
      {capability && !supported && <p role="alert">Ação indisponível nesta caixa. Confira as capacidades da integração e atualize o catálogo.</p>}
      <button type="button" onClick={() => setRevision(value => value + 1)}>Atualizar catálogo</button>
      {(node.type === 'tag' || node.type === 'attribute') && <>
        <label>{node.type === 'tag' ? 'Etiqueta' : 'Atributo da conversa'}<select value={typeof node.data.resourceId === 'string' ? node.data.resourceId : ''}
          disabled={!supported} onChange={event => {
            const chosen = resources.find(item => item.id === event.target.value); if (!chosen) return;
            chooseResource(chosen);
          }}><option value="">Selecione pelo nome</option>{resources.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {catalog && Boolean(node.data.resourceId) && !resource && <p role="alert">O recurso salvo não está disponível no catálogo desta caixa.</p>}
        {resource && resource.revision !== node.data.resourceRevision && <><p role="alert">O recurso foi atualizado. Confirme a versão atual e revise o valor antes de publicar.</p>
          <button type="button" disabled={!supported} onClick={() => chooseResource(resource)}>Usar versão atual do recurso</button></>}
        {catalog?.profile === 'STANDALONE' && <details><summary>{node.type === 'tag' ? 'Criar etiqueta local' : 'Criar atributo local'}</summary>
          <label>Nome do recurso<input maxLength={120} value={form.name} onChange={event => setFormFields({ name: event.target.value })} /></label>
          {node.type === 'attribute' && <><label>Tipo do atributo<select value={form.type} onChange={event => setFormFields({ type: event.target.value as Form['type'] })}>
            {[['string', 'Texto'], ['number', 'Número'], ['boolean', 'Sim ou não'], ['enum', 'Lista'], ['date', 'Data'], ['url', 'Endereço web']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>{form.type === 'enum' && <label>Opções, uma por linha<textarea value={form.options} onChange={event => setFormFields({ options: event.target.value })} /></label>}</>}
          <button type="button" disabled={!supported || !form.name.trim() || node.type === 'attribute' && form.type === 'enum' && !form.options.trim()} onClick={() => void createResource()}>Salvar recurso local</button>
        </details>}
      </>}
      {node.type === 'attribute' && definition && <>
        <label>Origem do valor<select value={source?.kind ?? 'LITERAL'} onChange={event => change({ valueSource: event.target.value === 'VARIABLE'
          ? { kind: 'VARIABLE', variable: '' } : { kind: 'LITERAL', value: defaultLiteral } })}><option value="LITERAL">Valor definido</option><option value="VARIABLE">Variável do fluxo</option></select></label>
        {source?.kind === 'VARIABLE' ? <label>Nome da variável<input maxLength={100} value={source.variable ?? ''} onChange={event => change({ valueSource: { kind: 'VARIABLE', variable: event.target.value } })} /></label>
          : definition.valueType === 'boolean' ? <label>Valor do atributo<select value={String(source?.value ?? false)} onChange={event => literal(event.target.value === 'true')}><option value="false">Não</option><option value="true">Sim</option></select></label>
            : definition.valueType === 'enum' ? <label>Valor do atributo<select value={String(source?.value ?? '')} onChange={event => literal(event.target.value)}>{definition.allowedValues.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
              : <label>Valor do atributo<input type={definition.valueType === 'number' ? 'number' : definition.valueType === 'date' ? 'date' : definition.valueType === 'url' ? 'url' : 'text'}
                maxLength={definition.maxLength} value={String(source?.value ?? '')} onChange={event => literal(definition.valueType === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value)} /></label>}
      </>}
      {node.type === 'note' && <><p>Nota privada do atendimento. Ela não é enviada ao WhatsApp.</p><label>Nota interna<textarea maxLength={4096} value={String(node.data.text ?? '')} onChange={event => change({ text: event.target.value })} /></label></>}
      {node.type==='domain'&&<DomainCommandFields data={node.data} owners={catalog?.capabilities.domain?.owners??[]} onChange={data=>{if(editable)onChange(data);}}/>}
      {node.type === 'resolve' && <p>Resolver e encerrar termina o ciclo do bot após a confirmação. Nenhuma próxima mensagem é enviada por este ciclo.</p>}
      {node.type === 'media' && <>
        <label>Arquivo privado<select value={typeof node.data.mediaId === 'string' ? node.data.mediaId : ''} disabled={!supported} onChange={event => {
          const file = files.find(item => item.id === event.target.value && item.status === 'READY'); if (file) change({ mediaId: file.id, mediaRevision: file.revision });
        }}><option value="">Selecione um arquivo</option>{Boolean(node.data.mediaId) && !selectedFile && <option value={String(node.data.mediaId)}>Arquivo salvo indisponível</option>}
          {files.map(file => <option key={file.id} value={file.id} disabled={file.status !== 'READY'}>{file.name}{file.status !== 'READY' ? ' · indisponível' : ''}</option>)}
        </select></label>
        <label>Enviar arquivo privado<input type="file" accept={accept} disabled={!supported} onChange={event => {
          const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = '';
        }} /></label><p>Até 16 MiB, com limites e verificação por tipo. O arquivo pertence à empresa, fluxo e caixa selecionados.</p>
        <label>Legenda<input maxLength={1024} value={String(node.data.caption ?? '')} onChange={event => change({ caption: event.target.value })} /></label>
        {selectedFile?.status === 'READY' && selectedFile.revision !== node.data.mediaRevision && <><p role="alert">A versão do arquivo mudou. Confirme o arquivo atual antes de publicar.</p>
          <button type="button" disabled={!supported} onClick={() => change({ mediaId: selectedFile.id, mediaRevision: selectedFile.revision })}>Usar versão atual do arquivo</button></>}
        {selectedFile?.status === 'READY' && <button type="button" onClick={() => {
          if (!window.confirm('Desativar este arquivo para novos envios?')) return;
          void mutate(async (signal, live) => { await transport.revokeMedia(channel, selectedFile.id, selectedFile.revision, signal); if (live()) setRevision(value => value + 1); });
        }}>Desativar arquivo</button>}
      </>}
      <details><summary>Opções avançadas</summary>
        {node.type !== 'resolve' && <label>Variável de resultado<input maxLength={100} value={String(node.data.target ?? '')} onChange={event => change({ target: event.target.value })} /></label>}
        <label>Tempo para confirmar a ação (segundos)<input type="number" min={0.1} max={30} step={0.1} value={Number(node.data.timeoutMs ?? 15000) / 1000} onChange={event => change({ timeoutMs: Math.round(Number(event.target.value) * 1000) })} /></label>
      </details>
    </fieldset>
  </div>;
}
