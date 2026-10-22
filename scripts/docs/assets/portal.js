export const documentationClientOptions = Object.freeze({
  persistAuthorization: false, queryConfigEnabled: false, validatorUrl: null, withCredentials: false,
  deepLinking: false, defaultModelsExpandDepth: -1, docExpansion: 'list', displayRequestDuration: true,
});

export function createRequestGuard(origin, paths, allowWrites) {
  const routes = Object.entries(paths).map(([route, methods]) => ({
    pattern: new RegExp('^' + route.split(/(\{[^}]+\})/).map(part => part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$'),
    methods,
  }));
  return request => {
    const url = new URL(request.url, origin), method = (request.method || 'GET').toLowerCase();
    if (url.origin !== origin || url.username || url.password || url.hash || !routes.some(route => route.pattern.test(url.pathname) && route.methods[method])) {
      throw new Error('DESTINO_NAO_PERMITIDO');
    }
    if (!allowWrites && method !== 'get') throw new Error('TESTES_DE_ESCRITA_DESATIVADOS');
    const headers = { ...request.headers };
    const names = Object.keys(headers).map(name => name.toLowerCase());
    if (names.includes('authorization') && names.includes('x-jrc-api-key')) throw new Error('UMA_CREDENCIAL_POR_REQUISICAO');
    for (const name of Object.keys(headers)) if (name.toLowerCase() === 'cookie') delete headers[name];
    return { ...request, headers, credentials: 'omit', withCredentials: false };
  };
}

async function startPortal() {
  const profile = document.querySelector('#profile'), writes = document.querySelector('#writes'), notice = document.querySelector('#notice');
  let generation = 0;
  async function render() {
    const current = ++generation, selected = profile.value;
    if (!['instances', 'chatwoot', 'messaging', 'events'].includes(selected)) return;
    document.querySelector('#swagger').replaceChildren();
    notice.textContent = 'Carregando contrato…';
    document.querySelector('#openapi').href = '/documentation/openapi-' + selected + '.json';
    document.querySelector('#postman').href = '/documentation/postman-' + selected + '.json';
    try {
      const response = await fetch('/documentation/openapi-' + selected + '.json', { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error('CONTRATO_INDISPONIVEL');
      const spec = await response.json();
      if (current !== generation) return;
      notice.textContent = writes.checked ? 'Testes de escrita habilitados nesta aba. Cada Try it out / Execute executa a operação real. Recarregar ou trocar o perfil remove a autorização.'
        : 'Consultas habilitadas. Para testar conexão ou envio, marque a opção de escrita e autorize somente uma credencial. Nenhuma operação executa automaticamente.';
      window.SwaggerUIBundle({ ...documentationClientOptions, spec, dom_id: '#swagger',
        supportedSubmitMethods: writes.checked ? ['get', 'post', 'put', 'patch', 'delete'] : ['get'],
        requestInterceptor: createRequestGuard(window.location.origin, spec.paths, writes.checked),
      });
    } catch {
      if (current === generation) notice.textContent = 'Contrato indisponível. Atualize a página ou contate a equipe JRC. Nenhuma chamada à API foi iniciada.';
    }
  }
  profile.addEventListener('change', () => { writes.checked = false; void render(); });
  writes.addEventListener('change', () => { void render(); });
  await render();
}
if (typeof document !== 'undefined' && document.querySelector('#swagger')) void startPortal();
