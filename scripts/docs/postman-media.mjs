const prefix = '/v1/messaging/channels/{id}';
const abort = "function abort(message) { pm.execution.setNextRequest(null); pm.execution.skipRequest(); throw new Error(message); }";
export function buildMediaPostman(contract) {
  const definitions = [
    { method: 'post', path: prefix + '/media', flag: 'allow_media_upload', name: 'Upload privado', required: ['media_file_path', 'media_mime', 'media_kind', 'media_name'], binary: true },
    { method: 'get', path: prefix + '/media/{mediaId}', name: 'Consultar estado do anexo', required: ['media_id'] },
    { method: 'post', path: prefix + '/partner-media', flag: 'allow_media_send', name: 'Enviar anexo com legenda', required: ['media_id', 'conversation_id', 'caption_json'] },
  ];
  const item = definitions.map(definition => {
    const operation = contract.paths?.[definition.path]?.[definition.method];
    if (!operation) throw new Error('MEDIA_POSTMAN_OPERATION_MISSING: ' + definition.path);
    const write = definition.method !== 'get';
    const required = ['broker_origin', 'jrc_api_key', 'channel_id', ...definition.required, ...(write ? ['idempotency_key'] : [])];
    const requestBody = definition.binary ? { mode: 'file', file: { src: '{{media_file_path}}' } }
      : write ? { mode: 'raw', raw: '{"conversationId":"{{conversation_id}}","mediaId":"{{media_id}}","caption":{{caption_json}}}', options: { raw: { language: 'json' } } } : undefined;
    const header = [{ key: 'Accept', value: 'application/json' }, { key: 'X-JRC-API-Key', value: '{{jrc_api_key}}' }];
    if (write) header.push({ key: 'Idempotency-Key', value: '{{idempotency_key}}' }, { key: 'Content-Type', value: definition.binary ? 'application/octet-stream' : 'application/json' });
    if (definition.binary) header.push({ key: 'X-JRC-Media-Mime', value: '{{media_mime}}' }, { key: 'X-JRC-Media-Kind', value: '{{media_kind}}' }, { key: 'X-JRC-Media-Name', value: '{{media_name}}' });
    return { name: definition.name + (write ? ' - opt-in ' + definition.flag : ''), item: [{ name: operation.summary,
      request: { method: definition.method.toUpperCase(), header, url: '{{broker_origin}}' + definition.path.replace('{id}', '{{channel_id}}').replace('{mediaId}', '{{media_id}}'),
        description: operation.description + '\n\nExecute somente esta pasta. Preencha os IDs privados manualmente a partir das respostas; a coleção não copia referências nem dispara a próxima ação. Upload e envio são intenções independentes com UUIDs próprios. Para legenda, caption_json contém uma string JSON válida. O arquivo deve existir localmente e media_name deve usar encodeURIComponent.',
        ...(requestBody ? { body: requestBody } : {}) },
      event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: [abort,
        ...(write ? [`if (pm.variables.get('${definition.flag}') !== 'true') abort('Ação desabilitada: ${definition.flag}.');`] : []),
        `for (const key of ${JSON.stringify(required)}) if (pm.variables.get(key) === undefined || pm.variables.get(key) === '') abort('Preencha a variável privada: ' + key);`,
        String.raw`const origin = String(pm.variables.get('broker_origin')); if (origin.includes('@') || !/^(https:\/\/[^/?#]+\/?|http:\/\/(localhost|127\.0\.0\.1)(:[0-9]+)?\/?)$/.test(origin)) abort('Use uma origem HTTPS sem caminho ou HTTP de laboratório local.');`,
        ...(write ? ["if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pm.variables.get('idempotency_key'))) abort('Idempotency-Key deve ser UUID.');"] : []),
        ...(write && !definition.binary ? [`try { JSON.parse(pm.variables.replaceIn(${JSON.stringify(requestBody.raw)})); } catch { abort('Preencha IDs e caption_json com JSON válido.'); }`] : []),
      ] } }, { listen: 'test', script: { type: 'text/javascript', exec: [
        ...(write ? ['pm.execution.setNextRequest(null); // Uma ação deliberada por execução; nunca encadear upload e envio.'] : []),
        `const expected = ${JSON.stringify(Object.keys(operation.responses).filter(code => Number(code) < 300).map(Number))};`,
        "pm.test('Status contratual de sucesso', () => pm.expect(pm.response.code).to.be.oneOf(expected));",
        "if (!expected.includes(pm.response.code)) { pm.execution.setNextRequest(null); throw new Error('Operação não concluída; consultar diagnóstico.'); }",
        "const result = pm.response.json(); if (result.state === 'UNKNOWN' || result.status === 'STORING' || result.status === 'FAILED') pm.execution.setNextRequest(null);",
      ] } }] }] };
  });
  return { info: { name: 'JRC Broker - anexos privados e envio QR (ações manuais)', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    description: 'Três operações reais; upload privado não envia mensagem. Escolha arquivo local, consulte READY e só então execute o envio em outra pasta deliberadamente. 201 cria referência; 202 confirma fila, não entrega. Não repetir UNKNOWN com novo UUID. Nenhuma credencial ou arquivo incluído.' },
    variable: [
      ...['broker_origin', 'jrc_api_key', 'channel_id', 'media_id', 'conversation_id', 'idempotency_key', 'media_file_path'].map(key => ({ key, value: '', ...(key === 'jrc_api_key' ? { type: 'secret' } : {}) })),
      { key: 'media_mime', value: 'image/png' }, { key: 'media_kind', value: 'image' }, { key: 'media_name', value: 'example.png' }, { key: 'caption_json', value: '""' },
      { key: 'allow_media_upload', value: 'false' }, { key: 'allow_media_send', value: 'false' },
    ], item };
}
