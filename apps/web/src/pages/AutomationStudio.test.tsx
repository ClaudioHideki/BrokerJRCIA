// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOMATION_NODE_CATALOG_V1, welcomeFlow } from '@jrc/contracts';
import { ApiClientError, type ApiClient } from '../api/client.js';
import { SessionProvider } from '../auth/SessionProvider.js';
import { AutomationEditorPage, AutomationsPage, NewAutomationPage, AutomationExecutionDetailPage } from './AutomationStudio.js';

const organization = { id:'92776cb0-bcba-45c0-98a3-2937fefdfdaf', name:'Empresa', slug:'empresa', role:'OWNER' as const };
const automationId = '11111111-2222-4333-8444-555555555555';
const definition = {
  schemaVersion:1 as const,
  id:automationId,
  organizationId:organization.id,
  name:'Atendimento principal',
  lifecycleStatus:'DRAFT' as const,
  draft:{revision:1,graph:welcomeFlow()},
  activeVersion:null,
  updatedAt:'2026-09-21T12:00:00.000Z',
};

function client(request:ApiClient['request']):ApiClient {
  return {request,restore:async()=>({user:{id:organization.id,email:'owner@example.test'},activeOrganization:organization,organizations:[organization]}),registerTenantPurge:()=>()=>{},subscribeToSessionExpiration:()=>()=>{},login:vi.fn(),logout:vi.fn(),selectOrganization:vi.fn(),switchOrganization:vi.fn()} as unknown as ApiClient;
}

function mountEditor(request:ApiClient['request']) {
  const withStatus=((path:string,init?:RequestInit)=>path==='/v1/automations/status'?Promise.resolve({enabled:true,canEdit:true,canSimulate:true,canPublish:true,reasons:[]}):request(path,init)) as ApiClient['request'];
  return render(<SessionProvider client={client(withStatus)}><MemoryRouter initialEntries={[`/automations/${automationId}/edit`]}><Routes><Route path="/automations/:id/edit" element={<AutomationEditorPage/>}/></Routes></MemoryRouter></SessionProvider>);
}

beforeEach(()=>sessionStorage.clear());

describe('Automation Studio',()=>{
  it.each(AUTOMATION_NODE_CATALOG_V1.filter(node=>node.availability==='AVAILABLE').map(node=>node.type))('opens a configuration form for available %s',async type=>{
    const graph=welcomeFlow();graph.nodes[1]!.type=type;graph.nodes[1]!.label='Bloco de teste';
    const request=vi.fn(async(path:string)=>path===`/v1/automations/${automationId}`?{...definition,draft:{revision:1,graph}}:path==='/v1/automation-nodes'?{data:AUTOMATION_NODE_CATALOG_V1}:Promise.reject(new Error(path))) as ApiClient['request'];
    mountEditor(request);fireEvent.click(await screen.findByRole('button',{name:'Configurar Bloco de teste'}));
    expect(screen.getByLabelText('Nome do bloco')).toHaveValue('Bloco de teste');
    const labels:Record<string,string[]>={message:['Mensagem'],input:['Pergunta','Variável'],menu:['Mensagem do menu','Variável'],condition:['Campo','Comparação','Valor'],variable:['Variável','Valor']};
    for(const label of labels[type]??[])expect(screen.getByLabelText(label)).toBeEnabled();
  });
  it('keeps offline drafts visible and editable with an explicit publication pause',async()=>{
    const request=vi.fn(async(path:string)=>path==='/v1/automations/status'?{enabled:false,canRead:true,canEdit:true,canSimulate:true,canPublish:false,reasons:['AUTOMATION_RUNTIME_DISABLED']}:path==='/v1/automations'?{data:[definition]}:Promise.reject(new Error(path))) as ApiClient['request'];
    render(<SessionProvider client={client(request)}><MemoryRouter><AutomationsPage/></MemoryRouter></SessionProvider>);
    expect(await screen.findByRole('heading',{name:'Atendimento principal'})).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('A execução de bots está pausada pela administração JRC');
    expect(screen.getByRole('link',{name:'Nova automação'})).toBeVisible();
  });
  it('creates drafts while publication is paused and explains the capability separately',async()=>{
    const request=vi.fn(async(path:string)=>path==='/v1/automations/status'?{enabled:false,canRead:true,canEdit:true,canSimulate:true,canPublish:false,reasons:['AUTOMATION_RUNTIME_DISABLED']}:Promise.reject(new Error(path))) as ApiClient['request'];
    render(<SessionProvider client={client(request)}><MemoryRouter><NewAutomationPage/></MemoryRouter></SessionProvider>);
    await waitFor(()=>expect(screen.getByLabelText('Arquivo JSON')).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Nome da automação'),{target:{value:'Meu bot'}});
    expect(screen.getByRole('button',{name:'Criar e abrir editor'})).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('rascunhos');
  });
  it('previews JSON automatically and lets the user cancel before creating an automation',async()=>{
    const request=vi.fn(async(path:string)=>{
      if(path==='/v1/automations/status')return {enabled:true};
      if(path==='/v1/automation-imports/preview')return {name:'Importação',graph:welcomeFlow(),report:{summary:{total:3,exact:3,partial:0,unsupported:0,manualReviewRequired:false},nodes:[],warnings:['Prévia sem gravação.']}};
      throw new Error(`Unexpected ${path}`);
    }) as ApiClient['request'];
    render(<SessionProvider client={client(request)}><MemoryRouter><NewAutomationPage/></MemoryRouter></SessionProvider>);
    const input=await screen.findByLabelText('Arquivo JSON');
    await waitFor(()=>expect(input).toBeEnabled());
    fireEvent.change(input,{target:{files:[{name:'chatbot.json',size:50,text:async()=>'{"format":"jrc-flows/1"}'}]}});
    expect(await screen.findByRole('heading',{name:'Revisar importação'})).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith('/v1/automation-imports/preview',expect.objectContaining({body:expect.stringContaining('"source":"AUTO"')}));
    expect(screen.queryByText(/n8n|typebot/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Cancelar importação'}));
    expect(screen.queryByRole('heading',{name:'Revisar importação'})).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalledWith('/v1/automation-imports',expect.anything());
    expect(request).not.toHaveBeenCalledWith('/v1/automations',expect.anything());
  });
  it('persists a reviewed import only on confirmation and avoids persisting it twice if draft creation is retried',async()=>{
    let createAttempts=0;const paths:string[]=[];
    const imported={name:'Importação',graph:welcomeFlow(),report:{summary:{total:3,exact:3,partial:0,unsupported:0,manualReviewRequired:false},nodes:[],warnings:[]}};
    const request=vi.fn(async(path:string)=>{paths.push(path);
      if(path==='/v1/automations/status')return {enabled:true};
      if(path==='/v1/automation-imports/preview')return imported;
      if(path==='/v1/automation-imports')return imported;
      if(path==='/v1/automations'){createAttempts++;if(createAttempts===1)throw new ApiClientError('Falha temporária.',503,'req-create-503');return {...definition,name:'Importação'};}
      throw new Error(`Unexpected ${path}`);
    }) as ApiClient['request'];
    render(<SessionProvider client={client(request)}><MemoryRouter initialEntries={['/automations/new']}><Routes><Route path="/automations/new" element={<NewAutomationPage/>}/><Route path="/automations/:id/edit" element={<div>Editor aberto</div>}/></Routes></MemoryRouter></SessionProvider>);
    const input=await screen.findByLabelText('Arquivo JSON');
    await waitFor(()=>expect(input).toBeEnabled());
    fireEvent.change(input,{target:{files:[{name:'chatbot.json',size:50,text:async()=>'{"format":"jrc-flows/1"}'}]}});
    expect(await screen.findByRole('heading',{name:'Revisar importação'})).toBeInTheDocument();
    expect(request).not.toHaveBeenCalledWith('/v1/automation-imports',expect.anything());
    fireEvent.click(screen.getByRole('button',{name:'Importar rascunho e abrir editor'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('req-create-503');
    expect(request).toHaveBeenCalledWith('/v1/automation-imports',expect.objectContaining({body:expect.stringContaining('"source":"AUTO"')}));
    fireEvent.click(screen.getByRole('button',{name:'Importar rascunho e abrir editor'}));
    expect(await screen.findByText('Editor aberto')).toBeVisible();
    expect(paths.filter(path=>path==='/v1/automation-imports')).toHaveLength(1);
    expect(paths.filter(path=>path==='/v1/automations')).toHaveLength(2);
  });
  it('explains disabled automation runtime and prevents an import from being sent',async()=>{
    const request=vi.fn(async(path:string)=>{
      if(path==='/v1/automations/status')return {enabled:false};
      throw new Error(`Unexpected ${path}`);
    }) as ApiClient['request'];
    render(<SessionProvider client={client(request)}><MemoryRouter><NewAutomationPage/></MemoryRouter></SessionProvider>);
    expect(await screen.findByRole('status')).toHaveTextContent('A execução de bots está pausada');
    const input=screen.getByLabelText('Arquivo JSON');
    expect(input).toBeDisabled();
    fireEvent.change(input,{target:{files:[{name:'chatbot.json',size:50,text:async()=>'{"format":"jrc-flows/1"}'}]}});
    expect(request).not.toHaveBeenCalledWith('/v1/automation-imports',expect.anything());
    expect(screen.getByRole('button',{name:'Criar e abrir editor'})).toBeDisabled();
  });
  it('archives with confirmation and offers restore without deleting the definition',async()=>{
    const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);
    let archived=false;
    const request=vi.fn(async(path:string)=>{
      if(path.endsWith('/archive')){archived=true;return {...definition,lifecycleStatus:'ARCHIVED'};}
      if(path==='/v1/automations/status')return {enabled:true};
      if(path==='/v1/automations')return {data:[{...definition,lifecycleStatus:archived?'ARCHIVED':'DRAFT'}]};
      if(path.endsWith('/legacy'))return {data:[],metrics:{legacyFlows:0}};
      throw new Error(path);
    }) as ApiClient['request'];
    render(<SessionProvider client={client(request)}><MemoryRouter><AutomationsPage/></MemoryRouter></SessionProvider>);
    fireEvent.click(await screen.findByRole('button',{name:'Arquivar'}));
    await waitFor(()=>expect(request).toHaveBeenCalledWith(`/v1/automations/${automationId}/archive`,expect.objectContaining({method:'POST',body:'{"archived":true}'})));
    fireEvent.click(screen.getByLabelText('Mostrar arquivadas'));
    expect(await screen.findByRole('button',{name:'Restaurar'})).toBeVisible();confirm.mockRestore();
  });
  it('cancels unsaved edits and clears the local recovery copy',async()=>{
    const request=vi.fn(async(path:string)=>path===`/v1/automations/${automationId}`?definition:{data:AUTOMATION_NODE_CATALOG_V1}) as ApiClient['request'];
    mountEditor(request);const name=await screen.findByLabelText('Nome da automação');fireEvent.change(name,{target:{value:'Erro de edição'}});
    const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);fireEvent.click(screen.getByRole('button',{name:'Cancelar alterações'}));
    expect(name).toHaveValue(definition.name);expect(sessionStorage.getItem(`jrc-automation-draft:${organization.id}:${automationId}`)).toBeNull();confirm.mockRestore();
  });
  it('lists only real automations returned by the runtime',async()=>{
    const request=vi.fn(async(path:string)=>path==='/v1/automations/status'?{enabled:true}:path==='/v1/automations'?{data:[definition]}:Promise.reject(new Error(`Unexpected ${path}`))) as ApiClient['request'];
    render(<SessionProvider client={client(request)}><MemoryRouter><AutomationsPage/></MemoryRouter></SessionProvider>);
    expect(await screen.findByRole('heading',{name:'Atendimento principal'})).toBeInTheDocument();
    expect(screen.getByRole('link',{name:'Editar'})).toHaveAttribute('href',`/automations/${automationId}/edit`);
  });

  it('loads later automation pages without duplicating a definition seen in an earlier page',async()=>{
    const second={...definition,id:'44444444-4444-4444-8444-444444444444',name:'Atendimento filial'};
    const request=vi.fn(async(path:string)=>path==='/v1/automations/status'?{enabled:true}
      :path==='/v1/automations'?{data:[definition],nextCursor:'next-1'}
      :path==='/v1/automations?cursor=next-1'?{data:[definition,second],nextCursor:null}
      :Promise.reject(new Error(`Unexpected ${path}`))) as ApiClient['request'];
    render(<SessionProvider client={client(request)}><MemoryRouter><AutomationsPage/></MemoryRouter></SessionProvider>);
    fireEvent.click(await screen.findByRole('button',{name:'Carregar mais automações'}));
    await waitFor(()=>expect(request).toHaveBeenCalledWith('/v1/automations?cursor=next-1'));
    expect(await screen.findByRole('heading',{name:'Atendimento filial'})).toBeVisible();
    expect(screen.getAllByRole('heading',{name:'Atendimento principal'})).toHaveLength(1);
    expect(screen.queryByRole('button',{name:'Carregar mais automações'})).not.toBeInTheDocument();
  });

  it('keeps a local draft and exposes the request id when saving returns 5xx',async()=>{
    const request=vi.fn(async(path:string,init?:RequestInit)=>{
      if(path===`/v1/automations/${automationId}`&&init?.method==='PUT')throw new ApiClientError('Falha temporária.',503,'req-save-503');
      if(path===`/v1/automations/${automationId}`)return definition;
      if(path==='/v1/automation-nodes')return {data:AUTOMATION_NODE_CATALOG_V1};
      throw new Error(`Unexpected ${path}`);
    }) as ApiClient['request'];
    mountEditor(request);
    const name=await screen.findByLabelText('Nome da automação');
    fireEvent.change(name,{target:{value:'Atendimento alterado'}});
    fireEvent.click(screen.getByRole('button',{name:'Salvar'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('req-save-503');
    await waitFor(()=>expect(sessionStorage.getItem(`jrc-automation-draft:${organization.id}:${automationId}`)).toContain('Atendimento alterado'));
    expect(name).toHaveValue('Atendimento alterado');
  });

  it('moves a selected block with the keyboard for accessible canvas editing',async()=>{
    const request=vi.fn(async(path:string)=>path===`/v1/automations/${automationId}`?definition:path==='/v1/automation-nodes'?{data:AUTOMATION_NODE_CATALOG_V1}:Promise.reject(new Error(`Unexpected ${path}`))) as ApiClient['request'];
    mountEditor(request);
    const block=await screen.findByRole('button',{name:'Configurar Mensagem recebida'});
    fireEvent.keyDown(block,{key:'ArrowRight'});
    expect(screen.getByText(/alterações locais preservadas/)).toBeInTheDocument();
  });
  it('locates the exact node in structured validation even when labels are duplicated',async()=>{
    const graph=welcomeFlow();graph.nodes[0]!.label='Boas-vindas';
    const request=vi.fn(async(path:string)=>path===`/v1/automations/${automationId}`?{...definition,draft:{revision:1,graph}}:path==='/v1/automation-nodes'?{data:AUTOMATION_NODE_CATALOG_V1}:path.endsWith('/validate')?{valid:false,diagnostics:[{nodeId:'welcome',field:'data.text',code:'INVALID_CONFIG',message:'Boas-vindas: informe uma mensagem.'}],errors:['Boas-vindas: informe uma mensagem.']}:Promise.reject(new Error(`Unexpected ${path}`))) as ApiClient['request'];
    mountEditor(request);
    fireEvent.click(await screen.findByRole('button',{name:'Validar'}));
    const focus=await screen.findByRole('button',{name:'Localizar bloco com erro'});
    expect(focus).toBeEnabled();fireEvent.click(focus);
    const blocks=screen.getAllByRole('button',{name:'Configurar Boas-vindas'});
    expect(blocks[1]!.parentElement).toHaveClass('flow-node--selected','flow-node--error');
    expect(blocks[0]!.parentElement).not.toHaveClass('flow-node--error');
    expect(screen.queryByRole('button',{name:/Consulta SQL/})).not.toBeInTheDocument();
    expect(screen.getByText(/rascunho salvo/)).toBeInTheDocument();
  });
  it('configures a three-team URA through the catalog and labels handoff as simulation only',async()=>{
    const integrationId='22222222-2222-4222-8222-222222222222';
    const teams=[{id:7,name:'Comercial',autoAssignment:false},{id:8,name:'Suporte',autoAssignment:false},{id:9,name:'Financeiro',autoAssignment:false}];
    const position={x:0,y:0},graph={nodes:[{id:'start',type:'start',label:'Início',position,data:{}},
      {id:'menu',type:'menu',label:'Menu principal',position,data:{text:'Escolha um setor',options:teams.map((team,index)=>({value:String(index+1),label:team.name}))}},
      ...teams.map(team=>({id:`handoff-${team.id}`,type:'handoff',label:`Transferir ${team.name}`,position,data:{handoffVersion:1}}))],
      edges:[{id:'s',source:'start',target:'menu',port:'next'},...teams.map((team,index)=>({id:`e${team.id}`,source:'menu',target:`handoff-${team.id}`,port:`option-${index+1}`}))]};
    let savedGraph=graph;
    const request=vi.fn(async(path:string,init?:RequestInit)=>{
      if(path===`/v1/automations/${automationId}`){if(init?.method==='PUT')savedGraph=JSON.parse(String(init.body)).graph;return {...definition,draft:{revision:1,graph:savedGraph}};}
      if(path==='/v1/automation-nodes')return {data:AUTOMATION_NODE_CATALOG_V1};
      if(path==='/v1/integrations/chatwoot')return {configured:true,baseUrl:'https://chatwoot.example.test',provisioningAvailable:false,account:{accountId:4,status:'READY',hasCredential:true,lastError:null},connections:[{id:integrationId,channelId:integrationId,inboxId:8,name:'Caixa principal',status:'READY',lastError:null,webhookUrl:'https://broker.example.test/events'}],jobs:{}};
      if(path.endsWith('/attendance-catalog'))return {scope:{organizationId:organization.id,channelId:integrationId,integrationId,destinationRevision:2,accountId:4,inboxId:8},observedAt:'2026-10-01T18:00:00.000Z',credentialRevision:3,
        teams,agents:[],labels:[],attributes:[],hours:{enabled:false,timezone:'Etc/UTC',days:[]},remoteBot:null,inboxPolicy:{greetingEnabled:false,autoAssignmentEnabled:false},capabilities:{teams:'SUPPORTED',agents:'SUPPORTED',inboxMembership:'SUPPORTED',labels:'SUPPORTED',attributes:'SUPPORTED',hours:'SUPPORTED',agentBot:'SUPPORTED',signatures:'UNVERIFIED',controlEvents:'UNVERIFIED',initialPending:'UNVERIFIED'}};
      if(path.endsWith('/simulate')){const input=JSON.parse(String(init?.body));const selected=savedGraph.nodes.find(node=>node.id==='handoff-8')!;
        return {status:input.replies?.length?'HANDOFF':'WAITING',wait:input.replies?.length?undefined:{kind:'EVENT',nodeId:'menu'},state:{variables:{}},effects:input.replies?.length?[{kind:'HANDOFF',payload:selected.data}]:[{kind:'SEND_TEXT',payload:{text:'1 - Comercial\n2 - Suporte\n3 - Financeiro'}}],trace:[]};}
      throw new Error(path);
    }) as ApiClient['request'];
    mountEditor(request);
    for(const team of teams){
      fireEvent.click(await screen.findByRole('button',{name:`Configurar Transferir ${team.name}`}));
      fireEvent.change(await screen.findByLabelText('Caixa de atendimento'),{target:{value:integrationId}});
      fireEvent.change(await screen.findByLabelText('Time de atendimento'),{target:{value:String(team.id)}});
    }
    fireEvent.click(screen.getByRole('button',{name:'Salvar'}));await screen.findByText('Rascunho salvo.');
    for(const team of teams)expect(savedGraph.nodes.find(node=>node.id===`handoff-${team.id}`)?.data).toEqual({handoffVersion:1,destination:{integrationId,destinationRevision:2,accountId:4,inboxId:8,credentialRevision:3},target:{teamId:team.id,agentId:null}});
    fireEvent.click(screen.getByRole('button',{name:'Testar'}));await screen.findByText(/1 - Comercial/);
    fireEvent.change(screen.getByLabelText('Próxima resposta'),{target:{value:'2'}});fireEvent.click(screen.getByRole('button',{name:'Enviar resposta no teste'}));
    expect(await screen.findByText('Transferência simulada para time 8. Nenhuma atribuição foi feita na central.')).toBeVisible();
  });
  it('continues a menu simulation using the conversation transcript',async()=>{
    const request=vi.fn(async(path:string,init?:RequestInit)=>{
      if(path===`/v1/automations/${automationId}`)return definition;
      if(path==='/v1/automation-nodes')return {data:AUTOMATION_NODE_CATALOG_V1};
      if(path.endsWith('/simulate')){const input=JSON.parse(String(init?.body));return {status:input.replies?.length?'HANDOFF':'WAITING',wait:input.replies?.length?undefined:{kind:'EVENT',nodeId:'menu'},state:{variables:{}},effects:[{kind:'SEND_TEXT',payload:{text:input.replies?.length?'Atendimento selecionado':'1 - Atendimento'}}],trace:[]};}
      throw new Error(path);
    }) as ApiClient['request'];
    mountEditor(request);fireEvent.click(await screen.findByRole('button',{name:'Testar'}));
    expect(await screen.findByText('1 - Atendimento')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Próxima resposta'),{target:{value:'1'}});
    fireEvent.click(screen.getByRole('button',{name:'Enviar resposta no teste'}));
    expect(await screen.findByText('Atendimento selecionado')).toBeVisible();
    expect(request).toHaveBeenCalledWith(`/v1/automations/${automationId}/simulate`,expect.objectContaining({body:JSON.stringify({text:'Olá',replies:['1']})}));
  });
});

it('cancels a queued execution only after confirmation and refreshes its status',async()=>{
 let canceled=false;const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);
 const request=vi.fn(async(path:string,init?:RequestInit)=>{if(path.endsWith('/cancel')){canceled=true;return {ok:true};}return {id:automationId,automationId,channelId:automationId,version:1,status:canceled?'CANCELED':'QUEUED',correlationId:'qa',nodes:[],outbox:[]};}) as ApiClient['request'];
 render(<SessionProvider client={client(request)}><MemoryRouter initialEntries={['/execution/'+automationId]}><Routes><Route path="/execution/:id" element={<AutomationExecutionDetailPage/>}/></Routes></MemoryRouter></SessionProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'Cancelar execução'}));
 expect(await screen.findByText('Cancelada')).toBeVisible();
 expect(request).toHaveBeenCalledWith('/v1/executions/'+automationId+'/cancel',expect.objectContaining({method:'POST'}));confirm.mockRestore();
});

it('directs a handed-off conversation to its mode control instead of resuming a terminal execution',async()=>{
 const request=vi.fn(async()=>({id:automationId,automationId,channelId:automationId,version:1,status:'HANDOFF',correlationId:'qa',nodes:[],outbox:[]})) as ApiClient['request'];
 render(<SessionProvider client={client(request)}><MemoryRouter initialEntries={['/execution/'+automationId]}><Routes><Route path="/execution/:id" element={<AutomationExecutionDetailPage/>}/></Routes></MemoryRouter></SessionProvider>);
 expect(await screen.findByRole('link',{name:'Retomar bot em Conversas'})).toHaveAttribute('href','/mensagens');expect(screen.queryByRole('button',{name:'Retomar automação'})).not.toBeInTheDocument();
});

it('keeps uncertain handoffs read-only while preserving manual reconciliation for other effects',async()=>{
 const effects=[
  {id:'handoff-unknown',nodeId:'Transferir incerto',kind:'HANDOFF',status:'UNKNOWN',attempts:1,remoteReference:null,lastError:'HANDOFF_REMOTE_OUTCOME_UNKNOWN'},
  {id:'handoff-sent',nodeId:'Transferir confirmado',kind:'HANDOFF',status:'SENT',attempts:1,remoteReference:'remote:42',lastError:null},
  {id:'handoff-failed',nodeId:'Transferir bloqueado',kind:'HANDOFF',status:'FAILED',attempts:1,remoteReference:null,lastError:'HANDOFF_INBOX_POLICY_UNSAFE'},
  {id:'message-unknown',nodeId:'Enviar mensagem',kind:'SEND_TEXT',status:'UNKNOWN',attempts:1,remoteReference:null,lastError:'MESSAGE_TIMEOUT'},
 ];
 const request=vi.fn(async()=>({id:automationId,automationId,channelId:automationId,version:1,status:'HANDOFF',correlationId:'qa',nodes:[],outbox:effects})) as ApiClient['request'];
 render(<SessionProvider client={client(request)}><MemoryRouter initialEntries={['/execution/'+automationId]}><Routes><Route path="/execution/:id" element={<AutomationExecutionDetailPage/>}/></Routes></MemoryRouter></SessionProvider>);
 await screen.findByText('Transferir incerto');
 expect(screen.getAllByRole('button',{name:'Confirmar envio'})).toHaveLength(1);
 expect(screen.getAllByRole('button',{name:'Confirmar não enviado'})).toHaveLength(1);
 expect(screen.getAllByRole('button',{name:'Manter incerto'})).toHaveLength(1);
 expect(screen.getByText('Transferência confirmada na central')).toBeVisible();
 expect(screen.getByText('Transferência não confirmada')).toBeVisible();
 expect(screen.getByText(/Reconciliação automática por consulta à central/)).toBeVisible();
 expect(screen.getByText('Transferência requer ação')).toBeVisible();
 expect(screen.getByText('HANDOFF_REMOTE_OUTCOME_UNKNOWN')).toBeVisible();
 expect(screen.getByText('HANDOFF_INBOX_POLICY_UNSAFE')).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'Confirmar envio'}));
 await waitFor(()=>expect(request).toHaveBeenCalledWith(`/v1/executions/${automationId}/reconcile`,expect.objectContaining({body:JSON.stringify({outboxId:'message-unknown',outcome:'CONFIRMED_SENT',evidenceCode:'OPERATOR_PROVIDER_CHECK'})})));
});

it('shows action-required and pending handoff states without displaying raw remote errors',async()=>{
 const request=vi.fn(async()=>({id:automationId,automationId,channelId:automationId,version:1,status:'HANDOFF',correlationId:'qa',nodes:[],outbox:[
  {id:'h1',nodeId:'Bloqueado',kind:'HANDOFF',status:'ACTION_REQUIRED',attempts:1,remoteReference:null,lastError:'remote error Authorization: Bearer synthetic-private-data'},
  {id:'h2',nodeId:'Pendente',kind:'HANDOFF',status:'PENDING',attempts:0,remoteReference:null,lastError:null},
 ]})) as ApiClient['request'];
 render(<SessionProvider client={client(request)}><MemoryRouter initialEntries={['/execution/'+automationId]}><Routes><Route path="/execution/:id" element={<AutomationExecutionDetailPage/>}/></Routes></MemoryRouter></SessionProvider>);
 await screen.findByText('Bloqueado');expect(screen.getByText('Transferência requer ação')).toBeVisible();expect(screen.getByText('Transferência pendente')).toBeVisible();
 expect(screen.getByText(/Revise o destino e o atendimento na central antes de retomar o bot/)).toBeVisible();
 expect(screen.queryByText(/synthetic-private-data/)).toBeNull();expect(screen.queryByRole('button',{name:'Confirmar envio'})).toBeNull();
});
