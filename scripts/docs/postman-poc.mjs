// Explicit POC workflow. Writes require allow_writes=true in the private local environment.
export function buildPocPostman() {
 const item=[];
 const request=(name,method,path,expected,body,after=[],binary=false)=>item.push({name,request:{method,
  header:[{key:'Accept',value:'application/json'},{key:'X-JRC-API-Key',value:'{{jrc_api_key}}'},
   ...(body===undefined?[]:[{key:'Content-Type',value:'application/json'}]),
   ...(method==='GET'?[]:[{key:'Idempotency-Key',value:'{{run_id}}-'+item.length}])],
  url:'{{broker_origin}}'+path,...(body===undefined?{}:{body:{mode:'raw',raw:JSON.stringify(body,null,2),options:{raw:{language:'json'}}}})},
  event:[{listen:'prerequest',script:{type:'text/javascript',exec:[
    "function abort(message) { pm.execution.setNextRequest(null); pm.execution.skipRequest(); throw new Error(message); }",
    "if (!pm.variables.get('broker_origin') || !pm.variables.get('jrc_api_key')) abort('Preencha URL e chave no ambiente privado.');",
    "if (!pm.collectionVariables.get('run_id')) pm.collectionVariables.set('run_id', 'poc-' + pm.variables.replaceIn('{{$guid}}'));",
    "for (const key of ['run_id','provider_account_id','instance_id','channel_id','conversation_id','endpoint_id','created_instance_id','created_instance_run_id','connected_instance_id','created_channel_id','created_channel_instance_id','created_channel_run_id','created_endpoint_id','created_endpoint_run_id']) { const stored=pm.collectionVariables.get(key), resolved=pm.variables.get(key); if (resolved !== undefined && resolved !== stored) abort('Variável gerenciada da POC sobrescrita por ambiente/data/local: ' + key); }",
    ...(['05','06','07','09','18'].some(prefix=>name.startsWith(prefix))?["if (!pm.collectionVariables.get('instance_id') || pm.collectionVariables.get('created_instance_id') !== pm.variables.get('instance_id') || pm.collectionVariables.get('created_instance_run_id') !== pm.collectionVariables.get('run_id')) abort('Instância não foi criada nesta rodada POC.');"]:[]),
    ...(['02','05','06','18'].some(prefix=>name.startsWith(prefix))?["pm.collectionVariables.unset('connected_instance_id');"]:[]),
    ...(['07','09'].some(prefix=>name.startsWith(prefix))?["if (!pm.variables.get('instance_id') || pm.variables.get('connected_instance_id') !== pm.variables.get('instance_id')) abort('Consulte CONNECTED da instância desta POC antes de ativar ou enviar.');"]:[]),
    ...(name.startsWith('09')?["if (!pm.collectionVariables.get('channel_id') || pm.variables.get('channel_id') !== pm.collectionVariables.get('created_channel_id') || pm.collectionVariables.get('created_channel_instance_id') !== pm.collectionVariables.get('instance_id') || pm.collectionVariables.get('created_channel_run_id') !== pm.collectionVariables.get('run_id')) abort('Canal não foi ativado para a instância desta rodada POC.');"]:[]),
    ...(name.startsWith('17')?["if (!pm.collectionVariables.get('endpoint_id') || pm.variables.get('endpoint_id') !== pm.collectionVariables.get('created_endpoint_id') || pm.collectionVariables.get('created_endpoint_run_id') !== pm.collectionVariables.get('run_id')) abort('Endpoint não foi criado nesta rodada POC.');"]:[]),
    ...(name.startsWith('18')?["if (!pm.variables.get('instance_id') || pm.variables.get('created_instance_id') !== pm.variables.get('instance_id')) abort('Desconexão permitida somente para a instância criada por esta POC.');"]:[]),
    ...(binary?["if (!pm.variables.get('media_id')) pm.execution.skipRequest();"]:[]),
    ...(method==='GET'?[]:["if (pm.variables.get('allow_writes') !== 'true') abort('Escrita desabilitada. Use somente tenant e número de homologação e defina allow_writes=true.');"])
  ]}},{listen:'test',script:{type:'text/javascript',exec:[
   `pm.test('Status contratual',()=>pm.expect(pm.response.code).to.be.oneOf(${JSON.stringify(expected)}));`,
   `if (!${JSON.stringify(expected)}.includes(pm.response.code)) { pm.execution.setNextRequest(null); throw new Error('Status inesperado: interromper e conciliar.'); }`,
   ...(binary?["pm.test('Anexo privado',()=>pm.expect(pm.response.headers.get('Content-Disposition')).to.include('attachment'));","pm.test('Sem cache',()=>pm.expect(pm.response.headers.get('Cache-Control')).to.eql('no-store'));"]:["pm.test('Resposta JSON',()=>pm.expect(pm.response.headers.get('Content-Type')).to.include('json'));","const body=pm.response.json();",
    ...(name.startsWith('02')?["if (body.instance && body.instance.id) { pm.collectionVariables.set('instance_id',body.instance.id); pm.collectionVariables.set('created_instance_id',body.instance.id); pm.collectionVariables.set('created_instance_run_id',pm.collectionVariables.get('run_id')); }"]:[]),
    `if (!${JSON.stringify(expected)}.includes(pm.response.code) || body.pending || body.reconciliationRequired) { pm.execution.setNextRequest(null); throw new Error('Progresso pendente ou incerto: consultar e conciliar, sem nova chave.'); }`]),...after]}}]});
 request('01 Descobrir provedor QR','GET','/v1/provider-accounts?provider=BAILEYS&limit=100',[200],undefined,["pm.test('Conta provisionada',()=>pm.expect(body.data.length).to.be.above(0)); if(body.data[0]) pm.collectionVariables.set('provider_account_id',body.data[0].id);"]);
 request('02 Criar instância de homologação','POST','/v1/instances',[200,201,202],{name:'POC API JRC',provider:'BAILEYS',providerAccountId:'{{provider_account_id}}'},["pm.test('Instância retornada',()=>pm.expect(body.instance.id).to.be.a('string'));pm.collectionVariables.set('instance_id',body.instance.id);"]);
 request('03 Listar instâncias','GET','/v1/instances?limit=20',[200]);
 request('04 Consultar instância','GET','/v1/instances/{{instance_id}}',[200]);
 request('05 Solicitar pareamento','POST','/v1/instances/{{instance_id}}/connect',[200,202],{},["pm.test('Ação de conexão',()=>pm.expect(body.action.type).to.be.a('string')); if (body.action.type !== 'NONE') pm.execution.setNextRequest(null); // Pare, escaneie o QR e retome na consulta de estado."]);
 request('06 Consultar estado','GET','/v1/instances/{{instance_id}}/status',[200],undefined,["pm.collectionVariables.unset('connected_instance_id'); if (body.status !== 'CONNECTED' || body.id !== pm.variables.get('instance_id')) { pm.execution.setNextRequest(null); throw new Error('Pareamento ainda não confirmado para esta instância.'); } pm.collectionVariables.set('connected_instance_id',body.id);"]);
 request('07 Ativar canal QR','POST','/v1/messaging/instances/{{instance_id}}/partner-activate',[200],{},["pm.test('Canal plano',()=>pm.expect(body.id).to.be.a('string'));pm.collectionVariables.set('channel_id',body.id);pm.collectionVariables.set('created_channel_id',body.id);pm.collectionVariables.set('created_channel_instance_id',pm.collectionVariables.get('instance_id'));pm.collectionVariables.set('created_channel_run_id',pm.collectionVariables.get('run_id'));"]);
 request('08 Listar canais','GET','/v1/messaging/channels',[200]);
 request('09 Enfileirar texto para destinatário de homologação','POST','/v1/messaging/channels/{{channel_id}}/partner-text',[202],{phoneNumber:'{{test_recipient}}',text:'Mensagem de homologação da API JRC'},["pm.test('Aceito não é entregue',()=>pm.expect(body.state).to.eql('ACCEPTED')); pm.collectionVariables.set('conversation_id',body.conversationId);"]);
 request('10 Listar conversas','GET','/v1/messaging/channels/{{channel_id}}/conversations',[200]);
 request('11 Consultar conversa','GET','/v1/messaging/conversations/{{conversation_id}}',[200]);
 request('12 Consultar mensagens','GET','/v1/messaging/conversations/{{conversation_id}}/messages',[200]);
 request('12b Baixar anexo recebido (opcional: preencher media_id)','GET','/v1/messaging/media/{{media_id}}',[200],undefined,[],true);
 request('13 Cadastrar receptor de homologação','POST','/v1/partner-webhooks',[201],{url:'{{receiver_url}}'},["pm.test('Segredo independente',()=>pm.expect(body.signingSecret).to.be.a('string'));pm.collectionVariables.set('endpoint_id',body.endpoint.id);pm.collectionVariables.set('created_endpoint_id',body.endpoint.id);pm.collectionVariables.set('created_endpoint_run_id',pm.collectionVariables.get('run_id')); // Guardar signingSecret no backend receptor; não registrar em console/relatório."]);
 request('14 Listar receptores sem segredos','GET','/v1/partner-webhooks',[200],undefined,["pm.test('Sem segredo na listagem',()=>pm.expect(JSON.stringify(body)).not.to.include('signingSecret'));"]);
 request('15 Ler feed','GET','/v1/partner-events?after=0&limit=50',[200],undefined,["pm.test('Retenção contratual',()=>pm.expect(body.retentionDays).to.eql(30));pm.test('Cursor preserva precisão',()=>pm.expect(body.nextCursor).to.be.a('string'));"]);
 request('16 Consultar entregas HTTP','GET','/v1/partner-webhook-deliveries?limit=50',[200]);
 request('17 Revogar receptor de homologação','DELETE','/v1/partner-webhooks/{{endpoint_id}}',[200]);
 request('18 Desconectar somente a instância criada nesta POC','POST','/v1/instances/{{instance_id}}/disconnect',[200,202],{});
 return {info:{name:'JRC Broker - POC explícita QR, texto e eventos',description:'Executa operações REAIS no destino informado. Exclusivo para homologação. Para em QR, pending, erro ou resultado incerto; escaneie e retome pela consulta CONNECTED antes de ativar/enviar. run_id identifica a mesma intenção durante retries: só limpe para uma NOVA POC após conciliar a anterior. A chave genérica não autoriza controle Chatwoot nem publica bots. QR e corpo de mensagens/segredos podem aparecer nos relatórios da ferramenta: guarde-os localmente e não compartilhe relatórios brutos.',schema:'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},variable:[
  {key:'broker_origin',value:''},{key:'jrc_api_key',value:'',type:'secret'},{key:'allow_writes',value:'false'},
  {key:'test_recipient',value:''},{key:'receiver_url',value:''},{key:'media_id',value:''},{key:'run_id',value:''}
 ],item};
}
